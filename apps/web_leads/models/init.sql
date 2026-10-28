-- ============================================================================
-- web_leads — enquiries from the public website (ceofactory.vc), and where
-- each one has been sent. 2 tables. MySQL 8 and TiDB.
-- ============================================================================
-- THE MODEL
--   The website's server code posts every form submission here
--   (POST /api/public/website/leads, apps/web_leads/routes/leads.js). The lead
--   is SAVED FIRST, then sent on to each destination (team email, Meta
--   Conversions API, CRM webhook). web_lead_deliveries keeps one row per lead
--   per destination, so a destination that was down is retried later and
--   nothing is lost.
--
-- WHY THESE CHOICES
--   - event_id is unique: the website names each submission, so a retried post
--     never makes a second lead, and Meta uses the same id to match the
--     browser pixel's event with ours (no double count).
--   - capi_context holds the visitor's IP, browser and Meta cookies, which only
--     the Meta destination needs. It is set to NULL as soon as that delivery is
--     finished (sent, skipped or given up), so they are not kept.
--   - Times are written from JavaScript (new Date()), never DEFAULT/NOW(): the
--     pool reads DATETIME as UTC (db.js timezone 'Z').
-- ============================================================================

CREATE TABLE IF NOT EXISTS web_leads (
  id             BIGINT NOT NULL AUTO_INCREMENT,
  event_id       VARCHAR(64)  NOT NULL,
  site           VARCHAR(60)  NOT NULL,
  form           VARCHAR(40)  NOT NULL,
  name           VARCHAR(200) NOT NULL,
  email          VARCHAR(254) NOT NULL,
  phone          VARCHAR(40)  NULL,
  organisation   VARCHAR(200) NULL,
  subject        VARCHAR(200) NULL,
  message        TEXT NULL,
  page_url       VARCHAR(500) NULL,
  referrer       VARCHAR(500) NULL,
  utm            JSON NULL,
  attribution    JSON NULL,                 -- product, pageId, landingUrl, landingPageId, cluster (website page context)
  consent_marketing TINYINT(1) NOT NULL DEFAULT 0,
  capi_context   JSON NULL,
  received_at    DATETIME(3) NOT NULL,
  deleted_at     DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY ux_web_leads_event (event_id),
  KEY ix_web_leads_received (received_at)
);

CREATE TABLE IF NOT EXISTS web_lead_deliveries (
  lead_id        BIGINT NOT NULL,
  target         VARCHAR(30) NOT NULL,      -- email | meta_capi | crm_webhook
  status         VARCHAR(12) NOT NULL,      -- pending | sending | sent | skipped | failed
  attempts       INT NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3) NULL,
  last_error     VARCHAR(500) NULL,
  updated_at     DATETIME(3) NOT NULL,
  PRIMARY KEY (lead_id, target),
  KEY ix_web_lead_deliveries_due (status, next_attempt_at)
);

SELECT IF((SELECT COUNT(*) FROM information_schema.tables
            WHERE table_schema = DATABASE() AND table_name IN ('web_leads', 'web_lead_deliveries')) = 2,
          'SCHEMA-OK', 'SCHEMA-MISSING') AS result;
