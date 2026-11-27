-- POSTGRES_DB only creates the hot "eg" database; the archive cluster for the
-- same region is a separate database (docs/database-design.md "Archival" — one
-- cold Postgres per region, same shard topology as the hot DB), so it's created
-- here via docker-entrypoint-initdb.d.
CREATE DATABASE order_service_archive_eg_test;
