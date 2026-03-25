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
  created_at timestamptz not null default now()
);

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
