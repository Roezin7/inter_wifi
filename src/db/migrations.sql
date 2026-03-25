-- ===== Core tables for InterWIFI bot =====
-- This migration is intentionally idempotent and aligns the schema with the
-- current application code under src/.

create extension if not exists pg_trgm;

create table if not exists wa_sessions (
  id bigserial primary key,
  session_id text unique not null,
  phone_e164 text not null,
  status text not null default 'OPEN',
  flow text not null,
  step int not null default 1,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);

alter table wa_sessions add column if not exists updated_at timestamptz;
update wa_sessions set updated_at = coalesce(updated_at, created_at, now()) where updated_at is null;
alter table wa_sessions alter column updated_at set default now();
alter table wa_sessions alter column updated_at set not null;
alter table wa_sessions add column if not exists closed_at timestamptz;
alter table wa_sessions add column if not exists data jsonb;
update wa_sessions set data = '{}'::jsonb where data is null;
alter table wa_sessions alter column data set default '{}'::jsonb;
alter table wa_sessions alter column data set not null;

create index if not exists idx_wa_sessions_phone_status on wa_sessions(phone_e164, status);

create table if not exists wa_messages (
  id bigserial primary key,
  session_id text,
  phone_e164 text not null,
  direction text not null,
  body text,
  media jsonb,
  raw jsonb,
  provider_msg_id text,
  provider_dedupe_key text,
  created_at timestamptz not null default now()
);

alter table wa_messages add column if not exists media jsonb;
alter table wa_messages add column if not exists raw jsonb;
alter table wa_messages add column if not exists provider_msg_id text;
alter table wa_messages add column if not exists provider_dedupe_key text;

create index if not exists idx_wa_messages_phone on wa_messages(phone_e164, created_at desc);
create unique index if not exists uq_wa_messages_provider_dedupe_key
  on wa_messages(provider_dedupe_key)
  where provider_dedupe_key is not null;

-- Legacy coverage table kept for backwards compatibility.
create table if not exists coverage_colonias (
  id bigserial primary key,
  colonia text not null,
  colonia_norm text not null,
  cobertura text not null,
  zona text,
  notas text
);

create index if not exists idx_coverage_colonia_norm on coverage_colonias(colonia_norm);

-- Current table used by coverageService.js
create table if not exists coverage_colonias_v2 (
  id bigserial primary key,
  name_display text not null,
  name_norm text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_coverage_colonias_v2_name_norm_trgm
  on coverage_colonias_v2
  using gin (name_norm gin_trgm_ops);

insert into coverage_colonias_v2 (name_display, name_norm, active)
select distinct on (c.colonia_norm)
  c.colonia,
  c.colonia_norm,
  coalesce(upper(c.cobertura), 'SI') <> 'NO'
from coverage_colonias c
where c.colonia_norm is not null
  and c.colonia_norm <> ''
  and not exists (
    select 1
    from coverage_colonias_v2 v2
    where v2.name_norm = c.colonia_norm
  );

create table if not exists contracts (
  id bigserial primary key,
  folio text unique not null,
  phone_e164 text not null,
  nombre text,
  colonia text,
  calle_numero text,
  cobertura text,
  zona text,
  telefono_contacto text,
  ine_frente_url text,
  ine_reverso_url text,
  ine_frente_media_id text,
  ine_reverso_media_id text,
  ine_frente_mime text,
  ine_reverso_mime text,
  status text not null default 'NUEVO',
  created_at timestamptz not null default now()
);

alter table contracts add column if not exists calle_numero text;
alter table contracts add column if not exists ine_frente_media_id text;
alter table contracts add column if not exists ine_reverso_media_id text;
alter table contracts add column if not exists ine_frente_mime text;
alter table contracts add column if not exists ine_reverso_mime text;

create table if not exists payments (
  id bigserial primary key,
  folio text unique not null,
  phone_e164 text not null,
  nombre text,
  mes text,
  monto text,
  comprobante_url text,
  comprobante_media_id text,
  comprobante_mime text,
  comprobante_public_url text,
  status text not null default 'NUEVO',
  created_at timestamptz not null default now()
);

alter table payments add column if not exists comprobante_media_id text;
alter table payments add column if not exists comprobante_mime text;
alter table payments add column if not exists comprobante_public_url text;

create table if not exists reports (
  id bigserial primary key,
  folio text unique not null,
  phone_e164 text not null,
  nombre text,
  descripcion text,
  status text not null default 'NUEVO',
  created_at timestamptz not null default now()
);

-- Legacy FAQ table kept for compatibility/imports.
create table if not exists faqs (
  id bigserial primary key,
  question text not null,
  answer text not null,
  tags text,
  question_norm text not null
);

create index if not exists idx_faqs_norm on faqs(question_norm);

-- Current FAQ table used by faqService.js
create table if not exists wa_faqs (
  id bigserial primary key,
  question text not null,
  answer text not null,
  category text not null default 'info',
  keywords text[],
  priority int not null default 0,
  active boolean not null default true,
  kind text not null default 'DETAIL',
  group_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table wa_faqs add column if not exists updated_at timestamptz;
update wa_faqs set updated_at = coalesce(updated_at, created_at, now()) where updated_at is null;
alter table wa_faqs alter column updated_at set default now();
alter table wa_faqs alter column updated_at set not null;
create index if not exists idx_wa_faqs_active_category on wa_faqs(active, category, priority desc, id asc);
create index if not exists idx_wa_faqs_group_key on wa_faqs(group_key);

insert into wa_faqs (question, answer, category, keywords, priority, active, kind, group_key)
select
  f.question,
  f.answer,
  'info',
  case
    when nullif(trim(f.tags), '') is null then null
    else regexp_split_to_array(f.tags, E'\\s*,\\s*')
  end,
  0,
  true,
  'DETAIL',
  null
from faqs f
where not exists (
  select 1
  from wa_faqs wf
  where wf.question = f.question
    and wf.answer = f.answer
);

insert into wa_faqs (question, answer, category, keywords, active, priority, kind, group_key)
select
  '¿Dónde se ubican?',
  $$📍 *Ubicación de InterWIFI*

Nos encontramos en:
• Hidalgo No. 311
• Col. Centro
• Encarnación de Díaz, Jalisco

Si quieres, dime tu *colonia* y te confirmo la cobertura en tu zona ✅$$,
  'info',
  ARRAY[
    'ubicacion',
    'ubicación',
    'direccion',
    'dirección',
    'donde estan',
    'dónde están',
    'oficina',
    'mapa',
    'como llego',
    'cómo llego',
    'google maps',
    'interwifi hidalgo 311',
    'centro'
  ],
  true,
  30,
  'DETAIL',
  null
where not exists (
  select 1 from wa_faqs where question = '¿Dónde se ubican?'
);

insert into wa_faqs (question, answer, category, keywords, active, priority, kind, group_key)
select
  '¿Qué fechas son para hacer el pago?',
  $$🗓️ *Fechas de pago*

El pago se realiza *del día 1 al 10 de cada mes*.

Si pagas fuera de ese rango, avísanos por aquí y lo revisamos ✅$$,
  'pagos',
  ARRAY[
    'pago',
    'pagos',
    'fechas',
    'fecha',
    'cuando pagar',
    'cuándo pagar',
    'del 1 al 10',
    '1 al 10',
    'corte',
    'vencimiento',
    'fecha limite',
    'fecha límite',
    'limite de pago',
    'límite de pago'
  ],
  true,
  25,
  'DETAIL',
  null
where not exists (
  select 1 from wa_faqs where question = '¿Qué fechas son para hacer el pago?'
);

insert into wa_faqs (question, answer, category, keywords, active, priority, kind, group_key)
select
  '¿Cómo puedo pagar en oficina?',
  $$💳 *Pago en oficina*

En oficina puedes pagar con:
• Efectivo
• Tarjeta *crédito/débito*

Si pagas en oficina, igual puedes enviarnos el comprobante por este chat para registrarlo ✅$$,
  'pagos',
  ARRAY[
    'pagar en oficina',
    'oficina',
    'efectivo',
    'tarjeta',
    'credito',
    'crédito',
    'debito',
    'débito',
    'terminal',
    'pago con tarjeta',
    'pago en mostrador'
  ],
  true,
  20,
  'DETAIL',
  null
where not exists (
  select 1 from wa_faqs where question = '¿Cómo puedo pagar en oficina?'
);

insert into wa_faqs (question, answer, category, keywords, active, priority, kind, group_key)
select
  '¿Qué horario tienen de oficina?',
  $$🕒 *Horario de atención y pago en oficina*

*Lunes, martes, miércoles, viernes y sábado*
• 9:00 a.m. – 2:30 p.m.
• 4:30 p.m. – 8:15 p.m.

*Jueves y domingo*
• 9:00 a.m. – 2:30 p.m.

Si necesitas apoyo, escríbenos por aquí y con gusto te atendemos 😊$$,
  'info',
  ARRAY[
    'horario',
    'horarios',
    'oficina',
    'abren',
    'cierran',
    'atencion',
    'atención',
    'hora',
    'a que hora',
    'a qué hora',
    'cuando abren',
    'cuándo abren',
    'cuando cierran',
    'cuándo cierran'
  ],
  true,
  30,
  'DETAIL',
  null
where not exists (
  select 1 from wa_faqs where question = '¿Qué horario tienen de oficina?'
);

insert into wa_faqs (question, answer, category, keywords, active, priority, kind, group_key)
select
  '¿A dónde puedo transferir o depositar el pago?',
  $$🏦 *Opciones para pagar*

Puedes pagar por:
• *OXXO (Spin by OXXO):* 4217 4700 8389 9167
• *Banco Azteca (Transferencia / Débito):* 5512 3823 4249 4848

*Beneficiario:* Alejandro Martín Cornejo

Al terminar, envía el *comprobante* por este chat (foto o captura) para registrarlo ✅$$,
  'pagos',
  ARRAY[
    'transferencia',
    'transferir',
    'deposito',
    'depósito',
    'cuenta',
    'tarjeta',
    'oxxo',
    'spin',
    'azteca',
    'banco azteca',
    'numero de tarjeta',
    'número de tarjeta',
    'beneficiario',
    'a donde deposito',
    'a dónde deposito',
    'a donde transfiero',
    'a dónde transfiero'
  ],
  true,
  30,
  'DETAIL',
  null
where not exists (
  select 1 from wa_faqs where question = '¿A dónde puedo transferir o depositar el pago?'
);

insert into wa_faqs (question, answer, category, keywords, active, priority, kind, group_key)
select
  '¿Qué debo hacer después de pagar con tarjeta o transferencia?',
  $$🧾 *Después de pagar*

Envíanos el *comprobante* por este mismo WhatsApp:
• Foto, captura o PDF

Sin comprobante no podemos registrar el pago.
Si gustas, también puedes escribir *“registrar pago”* para iniciar el proceso automático ✅$$,
  'pagos',
  ARRAY[
    'comprobante',
    'captura',
    'ticket',
    'transferi',
    'transferí',
    'ya pague',
    'ya pagué',
    'registrar pago',
    'confirmar pago',
    'despues de pagar',
    'después de pagar',
    'subir comprobante',
    'enviar comprobante'
  ],
  true,
  20,
  'DETAIL',
  null
where not exists (
  select 1 from wa_faqs where question = '¿Qué debo hacer después de pagar con tarjeta o transferencia?'
);

insert into wa_faqs (question, answer, category, keywords, active, priority, kind, group_key)
select
  '¿A qué número de WhatsApp envío el comprobante?',
  $$✅ *Aquí mismo*

Envíalo por este chat (foto/captura/PDF) y lo registramos.

Si quieres hacerlo en automático, escribe *“registrar pago”* y te guío paso a paso.$$,
  'pagos',
  ARRAY[
    'whatsapp',
    'numero',
    'número',
    'enviar comprobante',
    'a donde envio',
    'a dónde envío',
    'donde envio',
    'dónde envío',
    'a que numero',
    'a qué número',
    'a que whatsapp',
    'a qué whatsapp'
  ],
  true,
  15,
  'DETAIL',
  null
where not exists (
  select 1 from wa_faqs where question = '¿A qué número de WhatsApp envío el comprobante?'
);

insert into wa_faqs (question, answer, category, keywords, active, priority, kind, group_key)
select
  'Formas de pago (resumen)',
  $$💳 *Formas de pago*

*Pago en oficina:* efectivo, tarjeta o transferencia.

*OXXO (Spin by OXXO):*
• 4217 4700 8389 9167

*Banco Azteca (Transferencia / Débito):*
• 5512 3823 4249 4848

*Beneficiario:* Alejandro Martín Cornejo

🧾 *Si requieres factura:* se paga a esta cuenta BANORTE:
• *Interpc* (Mayra Selene Montoya Chávez)
• Cuenta: 1149553077
• CLABE: 072349011495530779
• RFC: MOCM840902JN3

✅ Si pagas con transferencia/tarjeta, envía tu *comprobante por este WhatsApp* para registrarlo.$$,
  'pagos',
  ARRAY[
    'formas de pago',
    'pago',
    'pagos',
    'como pagar',
    'cómo pagar',
    'donde pagar',
    'dónde pagar',
    'deposito',
    'depósito',
    'transferencia',
    'oxxo',
    'spin',
    'azteca',
    'banco azteca'
  ],
  true,
  100,
  'SUMMARY',
  'pagos'
where not exists (
  select 1 from wa_faqs where question = 'Formas de pago (resumen)'
);

insert into wa_faqs (question, answer, category, keywords, active, priority, kind, group_key)
select
  'Paquete de internet (resumen)',
  $$💰 *Paquete de internet (Encarnación de Díaz)*
_Sin contrato forzoso • No necesitas línea telefónica_

*Instalación:* $1,600
*Mensualidad:* $300

*Incluye:*
• Router inalámbrico
• Primer mensualidad

*Características:*
• *Velocidad:* 10MB
• Navegación ilimitada

*Requisitos:*
• INE
• Comprobante de domicilio
$$,
  'precios',
  ARRAY[
    'precio',
    'precios',
    'paquete',
    'paquetes',
    'plan',
    'planes',
    'cuanto cuesta',
    'cuánto cuesta',
    'mensualidad',
    'instalacion',
    'instalación',
    'internet',
    'paquete de internet',
    'contratar'
  ],
  true,
  100,
  'SUMMARY',
  'precios'
where not exists (
  select 1 from wa_faqs where question = 'Paquete de internet (resumen)'
);

-- updated_at trigger
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_sessions_updated_at on wa_sessions;
create trigger trg_sessions_updated_at
before update on wa_sessions
for each row execute function set_updated_at();

drop trigger if exists trg_wa_faqs_updated_at on wa_faqs;
create trigger trg_wa_faqs_updated_at
before update on wa_faqs
for each row execute function set_updated_at();
