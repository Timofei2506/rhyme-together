-- RHYME TOGETHER — схема базы (PostgreSQL / Supabase)
-- Соответствует интерфейсу server/store.js

create table if not exists rhyme_players (
  session_id      text primary key,
  name            text not null,
  created_at      timestamptz not null default now(),
  last_seen       timestamptz not null default now(),
  matches         int not null default 0,
  best_team_score numeric(5,1) not null default 0,
  last_song       text
);

create table if not exists rhyme_songs (
  id           text primary key,
  title        text not null,
  artist       text not null,
  license      text not null,
  bpm          int not null,
  beats_per_bar int not null,
  key_name     text,
  duration_sec numeric(7,3) not null,
  difficulty   smallint not null default 1,
  score        jsonb not null          -- полная партитура (аккорды + две партии)
);

create table if not exists rhyme_matches (
  id          text primary key,
  code        text not null,
  song_id     text references rhyme_songs(id),
  song_title  text not null,
  played_at   timestamptz not null default now(),
  team_pitch  numeric(5,1),
  team_rhythm numeric(5,1),
  team_sync   numeric(5,1),
  team_total  numeric(5,1),
  incomplete  boolean not null default false
);

create table if not exists rhyme_match_players (
  match_id   text references rhyme_matches(id) on delete cascade,
  session_id text references rhyme_players(session_id),
  name       text not null,
  part       char(1) not null check (part in ('A','B')),
  pitch      numeric(5,1),
  rhythm     numeric(5,1),
  sync       numeric(5,1),
  accuracy   numeric(5,1),
  notes_hit  int,
  notes_total int,
  primary key (match_id, part)
);

create index if not exists rhyme_matches_total_idx on rhyme_matches (team_total desc nulls last);
create index if not exists rhyme_players_best_idx on rhyme_players (best_team_score desc);
