INSERT INTO sales.accounts (email, name, country, settings, tags)
SELECT
    'user' || g || '@example.com',
    CASE WHEN g % 10 = 0 THEN NULL ELSE 'User ' || g END,
    (ARRAY['IN', 'US', 'DE', 'JP', 'BR'])[1 + g % 5],
    jsonb_build_object('theme', CASE WHEN g % 2 = 0 THEN 'dark' ELSE 'light' END, 'beta', g % 7 = 0),
    CASE WHEN g % 3 = 0 THEN ARRAY['vip'] ELSE '{}' END
FROM generate_series(1, 500) AS g;

-- Unicode and awkward strings.
INSERT INTO sales.accounts (email, name, country) VALUES
    ('naïve@example.com', 'Zoë Ångström', 'SE'),
    ('emoji@example.com', 'Ravi 🚀 Kumar', 'IN'),
    ('rtl@example.com', 'سارة', 'AE'),
    ('quote@example.com', 'O''Brien "the" Tab	Name', 'IE');

INSERT INTO sales.orders (account_id, status, total, placed_on, note)
SELECT
    1 + (g % 500),
    (ARRAY['pending', 'paid', 'paid', 'refunded'])[1 + g % 4],
    round((random() * 1000)::numeric, 2),
    date '2025-01-01' + (g % 365),
    CASE WHEN g % 50 = 0 THEN 'gift wrap' END
FROM generate_series(1, 20000) AS g;

INSERT INTO sales.order_items (order_id, line, sku, quantity, unit_price)
SELECT o.id, l, 'SKU-' || (abs(hashtext(o.id::text)) % 900 + 100), 1 + l, round((random() * 100)::numeric, 2)
FROM (SELECT id FROM sales.orders LIMIT 5000) o, generate_series(1, 3) AS l;

INSERT INTO sales.audit_log (at, actor, action, payload)
SELECT now() - (g || ' minutes')::interval, 'system', 'sync', jsonb_build_object('n', g)
FROM generate_series(1, 200) AS g;
-- Two identical rows: an edit must refuse to pick one.
INSERT INTO sales.audit_log (at, actor, action) VALUES
    ('2025-06-01 00:00:00+00', 'ops', 'duplicate'),
    ('2025-06-01 00:00:00+00', 'ops', 'duplicate');

INSERT INTO public.type_zoo VALUES
    (1, true, 32767, 9223372036854775807, 12345678901234567890.123456789, 3.14, 2.718281828459045,
     'plain', '\xdeadbeef', '2025-02-28', '13:45:00', '2025-02-28 13:45:00', '2025-02-28 13:45:00+05:30',
     '1 year 2 months 3 days', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '{"a": 1}', '{"nested": {"b": [1, 2]}}',
     '{1,2,3}', '192.168.0.1', '(1.5,2.5)'),
    (2, NULL, NULL, NULL, NULL, 'NaN', '-Infinity', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
     NULL, NULL, NULL);

REFRESH MATERIALIZED VIEW sales.revenue_by_country;
