CREATE TABLE seasons (
  id text PRIMARY KEY, name text NOT NULL, competition text NOT NULL,
  game_start_at timestamptz NOT NULL, config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id text PRIMARY KEY, display_name text NOT NULL UNIQUE,
  role text NOT NULL CHECK(role IN ('player','admin')),
  pin_hash text NOT NULL, pin_reset_required boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE login_attempts (
  key text PRIMARY KEY, failures integer NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now(), locked_until timestamptz
);
CREATE TABLE rounds (
  id text PRIMARY KEY, season_id text NOT NULL REFERENCES seasons(id),
  name text NOT NULL, stage text NOT NULL CHECK(stage IN ('league','playoff','round_of_16','quarter_final','semi_final','final')),
  number integer NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL
);
CREATE INDEX rounds_season ON rounds(season_id, number, starts_at);
CREATE TABLE teams (id text PRIMARY KEY, name text NOT NULL, short_name text NOT NULL, crest text);
CREATE TABLE matches (
  id text PRIMARY KEY, season_id text NOT NULL REFERENCES seasons(id), round_id text NOT NULL REFERENCES rounds(id),
  home_team_id text NOT NULL REFERENCES teams(id), away_team_id text NOT NULL REFERENCES teams(id),
  kickoff_at timestamptz NOT NULL, date_finland date NOT NULL,
  stage text NOT NULL CHECK(stage IN ('league','playoff','round_of_16','quarter_final','semi_final','final')),
  status text NOT NULL CHECK(status IN ('scheduled','live','final','postponed','cancelled')),
  leg integer CHECK(leg IN (1,2)), tie_id text,
  home_score integer CHECK(home_score >= 0), away_score integer CHECK(away_score >= 0),
  home_score_final integer CHECK(home_score_final >= 0), away_score_final integer CHECK(away_score_final >= 0),
  advancing_team_id text REFERENCES teams(id), provider_id text,
  scorer_player_ids text[] NOT NULL DEFAULT '{}', appeared_player_ids text[] NOT NULL DEFAULT '{}',
  registered_player_ids text[] NOT NULL DEFAULT '{}',
  scorer_data_complete boolean NOT NULL DEFAULT false, result_fingerprint text,
  CHECK(home_team_id <> away_team_id)
);
CREATE INDEX matches_season_date ON matches(season_id,date_finland,kickoff_at);
CREATE INDEX matches_round ON matches(round_id);
CREATE TABLE markets (
  id text PRIMARY KEY, match_id text NOT NULL REFERENCES matches(id),
  type text NOT NULL CHECK(type IN ('main_1x2','exact_score','anytime_goalscorer')),
  status text NOT NULL CHECK(status IN ('draft','open','locked','settled','voided')),
  required boolean NOT NULL DEFAULT false, UNIQUE(match_id,type)
);
CREATE TABLE selections (
  id text PRIMARY KEY, market_id text NOT NULL REFERENCES markets(id), label text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('home_win','draw','away_win','exact_score','player_anytime_goalscorer')),
  score_home integer CHECK(score_home >= 0), score_away integer CHECK(score_away >= 0), player_id text
);
CREATE INDEX selections_market ON selections(market_id);
CREATE TABLE odds_snapshots (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  selection_id text NOT NULL REFERENCES selections(id), decimal_odds numeric(12,4) NOT NULL CHECK(decimal_odds > 1 AND decimal_odds <= 10000),
  source text NOT NULL, captured_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX odds_selection_latest ON odds_snapshots(selection_id,captured_at DESC,id DESC);
CREATE TABLE bets (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text, user_id text NOT NULL REFERENCES users(id),
  season_id text NOT NULL REFERENCES seasons(id), market_id text NOT NULL REFERENCES markets(id),
  selection_id text NOT NULL REFERENCES selections(id), odds_snapshot_id text NOT NULL REFERENCES odds_snapshots(id),
  stake numeric(16,2) NOT NULL CHECK(stake > 0), bankroll_stake numeric(16,2) NOT NULL CHECK(bankroll_stake >= 0),
  bonus_stake numeric(16,2) NOT NULL CHECK(bonus_stake >= 0),
  status text NOT NULL DEFAULT 'placed' CHECK(status IN ('placed','won','lost','voided','cancelled')),
  payout numeric(20,2) NOT NULL DEFAULT 0,
  settlement_bankroll numeric(20,2) NOT NULL DEFAULT 0,
  settlement_bonus numeric(16,2) NOT NULL DEFAULT 0,
  settlement_bonus_kind text,
  created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz,
  CHECK(stake = bankroll_stake + bonus_stake)
);
CREATE UNIQUE INDEX one_active_bet_per_market ON bets(user_id,market_id) WHERE status <> 'cancelled';
CREATE INDEX bets_season_user ON bets(season_id,user_id);
CREATE INDEX bets_market ON bets(market_id);
CREATE TABLE ledger (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id text NOT NULL REFERENCES users(id), season_id text NOT NULL REFERENCES seasons(id),
  amount numeric(20,2) NOT NULL, type text NOT NULL, bet_id text REFERENCES bets(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_wallet ON ledger(season_id,user_id);
CREATE INDEX ledger_bet ON ledger(bet_id);
CREATE UNIQUE INDEX one_starting_balance ON ledger(user_id,season_id) WHERE type = 'starting_balance';
CREATE TABLE bonuses (
  user_id text NOT NULL REFERENCES users(id), season_id text NOT NULL REFERENCES seasons(id), date date NOT NULL,
  granted numeric(16,2) NOT NULL CHECK(granted >= 0), available numeric(16,2) NOT NULL DEFAULT 0 CHECK(available >= 0),
  used numeric(16,2) NOT NULL DEFAULT 0 CHECK(used >= 0), expired numeric(16,2) NOT NULL DEFAULT 0 CHECK(expired >= 0),
  converted numeric(16,2) NOT NULL DEFAULT 0 CHECK(converted >= 0), processed_at timestamptz,
  PRIMARY KEY(user_id,season_id,date), CHECK(granted = available + used + expired + converted)
);
CREATE TABLE idempotency (
  user_id text NOT NULL REFERENCES users(id), request_id text NOT NULL,
  request_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,request_id)
);
CREATE TABLE audit_log (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text, actor_id text REFERENCES users(id), action text NOT NULL,
  reason text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sync_status (
  provider text PRIMARY KEY, last_success_at timestamptz, last_error text, enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE club_standings (
  season_id text NOT NULL REFERENCES seasons(id), team_id text NOT NULL REFERENCES teams(id),
  position integer NOT NULL, played integer NOT NULL, won integer NOT NULL, drawn integer NOT NULL,
  lost integer NOT NULL, goals_for integer NOT NULL, goals_against integer NOT NULL, points integer NOT NULL,
  PRIMARY KEY(season_id,team_id)
);
