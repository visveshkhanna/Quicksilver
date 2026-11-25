-- A small schema that covers the types and shapes the client must handle:
-- composite and missing primary keys, foreign keys, NULLs, unicode, JSON,
-- arrays, binary, large numbers and time zones.

CREATE SCHEMA sales;

CREATE TABLE sales.accounts (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email       text NOT NULL UNIQUE,
    name        text,
    country     char(2),
    created_at  timestamptz NOT NULL DEFAULT now(),
    settings    jsonb NOT NULL DEFAULT '{}',
    tags        text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE sales.orders (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  bigint NOT NULL REFERENCES sales.accounts (id),
    status      text NOT NULL CHECK (status IN ('pending', 'paid', 'refunded')),
    total       numeric(12, 2) NOT NULL,
    placed_on   date NOT NULL,
    note        text
);
CREATE INDEX orders_account_id_idx ON sales.orders (account_id);

-- Composite primary key.
CREATE TABLE sales.order_items (
    order_id    uuid NOT NULL REFERENCES sales.orders (id) ON DELETE CASCADE,
    line        int NOT NULL,
    sku         text NOT NULL,
    quantity    int NOT NULL,
    unit_price  numeric(12, 2) NOT NULL,
    PRIMARY KEY (order_id, line)
);

-- No primary key at all: rows can only be named by every value.
CREATE TABLE sales.audit_log (
    at          timestamptz NOT NULL,
    actor       text,
    action      text NOT NULL,
    payload     jsonb
);

-- Every type the grid has to render.
CREATE TABLE public.type_zoo (
    id              int PRIMARY KEY,
    a_bool          boolean,
    a_smallint      smallint,
    a_bigint        bigint,
    a_numeric       numeric,
    a_real          real,
    a_double        double precision,
    a_text          text,
    a_bytea         bytea,
    a_date          date,
    a_time          time,
    a_timestamp     timestamp,
    a_timestamptz   timestamptz,
    a_interval      interval,
    a_uuid          uuid,
    a_json          json,
    a_jsonb         jsonb,
    a_int_array     int[],
    a_inet          inet,
    a_point         point
);

CREATE VIEW sales.paid_orders AS
    SELECT o.*, a.email
    FROM sales.orders o
    JOIN sales.accounts a ON a.id = o.account_id
    WHERE o.status = 'paid';

CREATE MATERIALIZED VIEW sales.revenue_by_country AS
    SELECT a.country, sum(o.total) AS revenue, count(*) AS orders
    FROM sales.orders o
    JOIN sales.accounts a ON a.id = o.account_id
    GROUP BY a.country;

CREATE FUNCTION sales.account_total(p_account bigint) RETURNS numeric
    LANGUAGE sql STABLE
    AS $$ SELECT coalesce(sum(total), 0) FROM sales.orders WHERE account_id = p_account $$;
