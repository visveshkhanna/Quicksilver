CREATE TABLE quicksilver_dev.events
(
    id       UInt64,
    at       DateTime64(3, 'UTC'),
    kind     LowCardinality(String),
    user_id  Nullable(UInt64),
    props    Map(String, String)
)
ENGINE = MergeTree
ORDER BY (at, id);

INSERT INTO quicksilver_dev.events
SELECT number, toDateTime64('2025-01-01 00:00:00', 3, 'UTC') + number, ['view', 'click', 'buy'][1 + number % 3],
       if(number % 10 = 0, NULL, number % 1000), map('source', 'seed')
FROM numbers(100000);
