-- Deskly (B2B helpdesk SaaS) schema
CREATE TABLE accounts (id serial PRIMARY KEY, name text, plan text, -- starter|growth|enterprise
  mrr numeric, seats int, created_at timestamptz);
CREATE TABLE agents (id serial PRIMARY KEY, name text, team text, -- triage|technical|billing
  active boolean);
CREATE TABLE tickets (id serial PRIMARY KEY, account_id int REFERENCES accounts(id),
  queue text, -- new|triage|in_progress|waiting_customer|resolved
  priority text, opened_at timestamptz, first_response_at timestamptz, resolved_at timestamptz,
  sla_breached boolean DEFAULT false);
CREATE TABLE csat_responses (ticket_id int, score int, comment text);
-- context from the team: ~340 accounts. Top accounts by MRR: Initech $8.2k, Globex $6.1k,
-- Umbrella $5.4k, Stark $4.9k, Wayne $3.1k, rest ~$41k combined.
-- Queues right now: new 47, triage 31, in_progress 58, waiting_customer 112, resolved today 96.
-- 9 tickets are SLA-breached (all in triage, mostly Globex). CSAT 7-day avg: 4.6/5.
-- Tickets opened today: 183. waiting_customer has been growing all week (was 60 on Monday).
