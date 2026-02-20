-- ===== Core tables for InterWIFI bot =====

create table if not exists wa_sessions (
  id bigserial primary key,
  session_id text unique not null,
  phone_e164 text not null,
  status text not null default 'OPEN',  -- OPEN/CLOSED
  flow text not null,                   -- CONTRATO/FALLA/PAGO/FAQ
  step int not null default 1,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_wa_sessions_phone_status on wa_sessions(phone_e164, status);

create table if not exists wa_messages (
  id bigserial primary key,
  session_id text,
  phone_e164 text not null,
  direction text not null,  -- IN/OUT
  body text,
  media jsonb,
  raw jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_wa_messages_phone on wa_messages(phone_e164, created_at desc);

create table if not exists coverage_colonias (
  id bigserial primary key,
  colonia text not null,
  colonia_norm text not null,
  cobertura text not null,  -- SI/NO
  zona text,
  notas text
);

create index if not exists idx_coverage_colonia_norm on coverage_colonias(colonia_norm);

create table if not exists contracts (
  id bigserial primary key,
  folio text unique not null,
  phone_e164 text not null,
  nombre text,
  colonia text,
  cobertura text,
  zona text,
  telefono_contacto text,
  ine_frente_url text,
  ine_reverso_url text,
  status text not null default 'NUEVO',
  created_at timestamptz not null default now()
);

create table if not exists payments (
  id bigserial primary key,
  folio text unique not null,
  phone_e164 text not null,
  nombre text,
  mes text,
  monto text,
  comprobante_url text,
  status text not null default 'NUEVO',
  created_at timestamptz not null default now()
);

create table if not exists reports (
  id bigserial primary key,
  folio text unique not null,
  phone_e164 text not null,
  nombre text,
  descripcion text,
  status text not null default 'NUEVO',
  created_at timestamptz not null default now()
);

create table if not exists faqs (
  id bigserial primary key,
  question text not null,
  answer text not null,
  tags text,
  question_norm text not null
);

create index if not exists idx_faqs_norm on faqs(question_norm);

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