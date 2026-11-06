-- Applied explicitly by sale:migrate, never implicitly by a public request.
BEGIN;
CREATE TABLE IF NOT EXISTS agnt_sale (
  id integer PRIMARY KEY CHECK (id = 1),
  state text NOT NULL DEFAULT 'CLOSED' CHECK (state IN ('CLOSED','OPEN','PAUSED')),
  sold integer NOT NULL DEFAULT 0 CHECK (sold BETWEEN 0 AND 4444),
  curve_version text NOT NULL,
  schedule_hash text NOT NULL
);
CREATE TABLE IF NOT EXISTS agnt_sale_accounts (
  user_id text PRIMARY KEY,
  available bigint NOT NULL DEFAULT 0 CHECK (available >= 0),
  held bigint NOT NULL DEFAULT 0 CHECK (held >= 0),
  frozen boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS agnt_sale_quotes (
  id uuid PRIMARY KEY, user_id text NOT NULL, quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 4444),
  curve_version text NOT NULL, total bigint NOT NULL CHECK (total > 0), expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS agnt_sale_purchases (
  id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES agnt_sale_accounts(user_id),
  idempotency_key text NOT NULL, request_hash text NOT NULL,
  first_serial integer NOT NULL, quantity integer NOT NULL CHECK (quantity > 0),
  total bigint NOT NULL CHECK (total > 0), curve_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS agnt_sale_passes (
  serial integer PRIMARY KEY CHECK (serial BETWEEN 1 AND 4444),
  owner_id text NOT NULL REFERENCES agnt_sale_accounts(user_id),
  purchase_id uuid NOT NULL REFERENCES agnt_sale_purchases(id),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','SUSPENDED')),
  metadata_hash text NOT NULL
);
CREATE TABLE IF NOT EXISTS agnt_sale_ledger (
  id uuid PRIMARY KEY, reference text UNIQUE NOT NULL,
  debit_account text NOT NULL, credit_account text NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now(), CHECK (debit_account <> credit_account)
);
CREATE TABLE IF NOT EXISTS agnt_sale_addresses (
  user_id text PRIMARY KEY REFERENCES agnt_sale_accounts(user_id),
  network text NOT NULL CHECK (network IN ('mainnet','testnet')),
  address text UNIQUE NOT NULL, receiver_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agnt_sale_deposits (
  receipt_id text PRIMARY KEY, user_id text NOT NULL REFERENCES agnt_sale_accounts(user_id),
  txid text NOT NULL, amount bigint NOT NULL CHECK (amount > 0),
  confirmations integer NOT NULL CHECK (confirmations >= 0),
  block_hash text, state text NOT NULL CHECK (state IN ('CONFIRMING','CREDITED','ORPHANED')),
  credited boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agnt_sale_withdrawals (
  id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES agnt_sale_accounts(user_id),
  idempotency_key text NOT NULL, request_hash text NOT NULL,
  destination text NOT NULL, amount bigint NOT NULL CHECK (amount > 0),
  fee_limit bigint NOT NULL CHECK (fee_limit >= 0),
  state text NOT NULL DEFAULT 'HELD' CHECK (state IN ('HELD','APPROVED','SIGNED','BROADCAST','PAID','CANCELED','REVIEW')),
  signer_reference text UNIQUE, txid text UNIQUE, actual_fee bigint,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS agnt_sale_events (
  id uuid PRIMARY KEY, kind text NOT NULL, user_id text NOT NULL, reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(kind,reference)
);
CREATE TABLE IF NOT EXISTS agnt_sale_usage (
  user_id text NOT NULL, day date NOT NULL, calls integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
  PRIMARY KEY(user_id,day)
);
CREATE TABLE IF NOT EXISTS agnt_sale_outbox (
  event_id uuid PRIMARY KEY REFERENCES agnt_sale_events(id),
  state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','RETRY','DELIVERED','FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_retry_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz
);
CREATE TABLE IF NOT EXISTS agnt_sale_notifications (
  event_id uuid PRIMARY KEY REFERENCES agnt_sale_events(id),
  user_id text NOT NULL, kind text NOT NULL, reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz
);
CREATE INDEX IF NOT EXISTS agnt_sale_outbox_due ON agnt_sale_outbox(next_retry_at,event_id) WHERE state IN ('PENDING','RETRY');
CREATE INDEX IF NOT EXISTS agnt_sale_notifications_owner ON agnt_sale_notifications(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS agnt_deposit_scan_cursors (
  user_id text NOT NULL, network text NOT NULL, wallet_account_uuid text NOT NULL,
  genesis_hash text NOT NULL, start_height integer NOT NULL CHECK(start_height >= 0),
  next_height integer NOT NULL CHECK(next_height >= 0), previous_hash text,
  PRIMARY KEY(user_id,network)
);
CREATE TABLE IF NOT EXISTS agnt_sale_canceled_requests (
  user_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('purchase','withdrawal')),
  idempotency_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,kind,idempotency_key)
);
ALTER TABLE agnt_sale_withdrawals ADD COLUMN IF NOT EXISTS settlement_block_hash text;
ALTER TABLE agnt_sale_withdrawals ADD COLUMN IF NOT EXISTS settlement_review boolean NOT NULL DEFAULT false;
ALTER TABLE agnt_sale_withdrawals ADD COLUMN IF NOT EXISTS settlement_block_height integer;
ALTER TABLE agnt_sale_withdrawals ADD COLUMN IF NOT EXISTS confirmations integer CHECK(confirmations>=0);
ALTER TABLE agnt_sale_withdrawals ADD COLUMN IF NOT EXISTS required_confirmations integer CHECK(required_confirmations>0);
ALTER TABLE agnt_sale_withdrawals ADD COLUMN IF NOT EXISTS confirmation_checked_at timestamptz;
ALTER TABLE agnt_sale_deposits ADD COLUMN IF NOT EXISTS block_height integer;
ALTER TABLE agnt_sale_deposits ADD COLUMN IF NOT EXISTS required_confirmations integer CHECK(required_confirmations>0);
ALTER TABLE agnt_sale ADD COLUMN IF NOT EXISTS access_policy_version text;
ALTER TABLE agnt_sale ADD COLUMN IF NOT EXISTS access_duration_days integer;
ALTER TABLE agnt_sale ADD COLUMN IF NOT EXISTS access_daily_calls integer;
ALTER TABLE agnt_sale_quotes ADD COLUMN IF NOT EXISTS access_policy_version text;
ALTER TABLE agnt_sale_purchases ADD COLUMN IF NOT EXISTS access_policy_version text;
CREATE OR REPLACE FUNCTION agnt_lock_issued_access_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.access_policy_version,OLD.access_duration_days,OLD.access_daily_calls)
    IS DISTINCT FROM (NEW.access_policy_version,NEW.access_duration_days,NEW.access_daily_calls)
    AND (OLD.sold>0 OR EXISTS(SELECT 1 FROM agnt_sale_purchases)) THEN
    RAISE EXCEPTION 'issued_access_policy_is_immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS agnt_lock_issued_access_policy ON agnt_sale;
CREATE TRIGGER agnt_lock_issued_access_policy BEFORE UPDATE ON agnt_sale FOR EACH ROW EXECUTE FUNCTION agnt_lock_issued_access_policy();
CREATE TABLE IF NOT EXISTS agnt_sale_credit_reviews (
  receipt_id text PRIMARY KEY REFERENCES agnt_sale_deposits(receipt_id),
  user_id text NOT NULL REFERENCES agnt_sale_accounts(user_id),
  credited_amount bigint NOT NULL CHECK(credited_amount > 0),
  coverage_state text NOT NULL CHECK(coverage_state IN ('ORPHANED','UNCONFIRMED','RESTORED')),
  confirmations integer NOT NULL CHECK(confirmations >= 0),
  required_confirmations integer NOT NULL CHECK(required_confirmations > 0),
  first_detected_at timestamptz NOT NULL DEFAULT now(), checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agnt_sale_signed_receipts (
  purchase_id uuid PRIMARY KEY REFERENCES agnt_sale_purchases(id),
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION agnt_lock_signed_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'signed_receipt_is_immutable';
END;
$$;
DROP TRIGGER IF EXISTS agnt_lock_signed_receipt ON agnt_sale_signed_receipts;
CREATE TRIGGER agnt_lock_signed_receipt BEFORE UPDATE OR DELETE ON agnt_sale_signed_receipts FOR EACH ROW EXECUTE FUNCTION agnt_lock_signed_receipt();
CREATE TABLE IF NOT EXISTS agnt_treasury_limits (
  id integer PRIMARY KEY CHECK(id=1),
  max_payout bigint NOT NULL CHECK(max_payout>0),
  max_outstanding bigint NOT NULL CHECK(max_outstanding>=max_payout)
);
CREATE TABLE IF NOT EXISTS agnt_treasury_operators (
  actor_id text PRIMARY KEY CHECK(length(actor_id) BETWEEN 1 AND 200),
  enabled boolean NOT NULL DEFAULT false,
  authorization_version uuid NOT NULL
);
CREATE TABLE IF NOT EXISTS agnt_withdrawal_approval_votes (
  withdrawal_id uuid NOT NULL REFERENCES agnt_sale_withdrawals(id),
  actor_id text NOT NULL REFERENCES agnt_treasury_operators(actor_id),
  authorization_version uuid NOT NULL,
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(withdrawal_id,actor_id)
);
CREATE OR REPLACE FUNCTION agnt_require_operator_reauthorization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT OLD.enabled AND NEW.enabled AND OLD.authorization_version=NEW.authorization_version THEN
    RAISE EXCEPTION 'treasury_operator_reauthorization_requires_new_version';
  END IF;
  IF NEW.enabled AND (NOT OLD.enabled OR OLD.authorization_version<>NEW.authorization_version)
    AND EXISTS(SELECT 1 FROM agnt_withdrawal_approval_votes WHERE actor_id=OLD.actor_id AND authorization_version=NEW.authorization_version) THEN
    RAISE EXCEPTION 'treasury_operator_authorization_version_reused';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS agnt_require_operator_reauthorization ON agnt_treasury_operators;
CREATE TRIGGER agnt_require_operator_reauthorization BEFORE UPDATE ON agnt_treasury_operators FOR EACH ROW EXECUTE FUNCTION agnt_require_operator_reauthorization();
CREATE OR REPLACE FUNCTION agnt_lock_approval_vote() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'withdrawal_approval_vote_is_immutable';
END;
$$;
DROP TRIGGER IF EXISTS agnt_lock_approval_vote ON agnt_withdrawal_approval_votes;
CREATE TRIGGER agnt_lock_approval_vote BEFORE UPDATE OR DELETE ON agnt_withdrawal_approval_votes FOR EACH ROW EXECUTE FUNCTION agnt_lock_approval_vote();
ALTER TABLE agnt_sale_accounts ADD COLUMN IF NOT EXISTS request_generation integer NOT NULL DEFAULT 0 CHECK(request_generation>=0);
COMMIT;
