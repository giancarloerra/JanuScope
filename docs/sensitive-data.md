# Restrict sensitive data before it is queried

Use backend permissions when a protected field must not be accessible to the MCP client or its model provider. JanuScope's field and regex rules inspect output; they do not track which source data produced an alias, encoding, fragment or calculation. Read-only access alone does not prevent those disclosures.

This guide adds an **optional stricter deployment**. It does not change existing credentials, bundled controls or custom configurations. A strict role intentionally rejects queries that used to read protected columns, including counts, presence checks and predicates on those columns. Keep the existing deployment when matching-value redaction meets its requirements; choose the stricter role when source-field isolation is required.

## PostgreSQL example

Use a new dedicated login for the MCP and schema introspection. The following illustrates the tested synthetic fixture, with a `benchmark_fixture` database and a `public.members` table containing `id`, `display_name` and protected fields. It is not an automatic migration for an existing database. Review the real objects and provision a separate credential through the deployment's secret workflow.

First establish that the role has no ownership, administrative privileges or role memberships that provide broader access. Remove effective broad access from every relevant source. PostgreSQL adds direct, inherited and `PUBLIC` privileges together; revoking one column does not override a table-wide `SELECT` grant. Superusers bypass ordinary object privileges. [PostgreSQL GRANT](https://www.postgresql.org/docs/17/sql-grant.html).

```sql
CREATE ROLE strict_reader LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE benchmark_fixture TO strict_reader;
GRANT USAGE ON SCHEMA public TO strict_reader;

-- Prerequisite: no inherited or PUBLIC grant provides broader access.
GRANT SELECT (id, display_name) ON public.members TO strict_reader;

ALTER ROLE strict_reader SET default_transaction_read_only = on;
ALTER ROLE strict_reader SET statement_timeout = '3s';
```

Grant other tables or columns individually after reviewing their contents. Avoid a table-wide grant on a protected table: it also allows reading future columns. Keep the same restricted connection in the upstream MCP and `dbSchema.connectionString`; a separate privileged introspection credential would create another disclosure path for metadata.

An explicitly reviewed view is another option:

```sql
CREATE VIEW public.safe_members AS
  SELECT id, display_name FROM public.members;
GRANT SELECT ON public.safe_members TO strict_reader;
```

A normal view can use its owner's privileges to access underlying data. Review its definition, owner and effective grants; do not expose an existing view merely because its name sounds harmless. An invoker view has different permission behavior. [PostgreSQL CREATE VIEW](https://www.postgresql.org/docs/17/sql-createview.html).

Functions need a separate review. A `SECURITY DEFINER` function or dynamic-SQL routine can return protected data without granting the caller access to the source column. A familiar function name can also resolve to an application-defined overload. Remove unsafe `EXECUTE` access from direct, inherited and `PUBLIC` grants. New functions normally grant execution to `PUBLIC`. [PostgreSQL CREATE FUNCTION](https://www.postgresql.org/docs/17/sql-createfunction.html).

For each role that creates functions, review its future default grants. For example, the synthetic fixture's owner used:

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
```

This affects future functions created by that role, not existing routines or objects created by another owner. A schema-scoped revoke alone cannot subtract a global `PUBLIC` execution default. Re-grant only approved routines to the appropriate callers. Changes to shared grants affect other applications and belong in a reviewed deployment. [PostgreSQL default privileges](https://www.postgresql.org/docs/17/sql-alterdefaultprivileges.html).

## Verify the actual connection

Connect through the same MCP and credential that the model will use. Verify the effective identity, then both permitted and refused queries:

```sql
-- Expected to succeed under the example's column grants.
SELECT current_user, session_user;
SELECT id, display_name FROM public.members ORDER BY id LIMIT 10;

-- Expected to fail with a backend permission error.
SELECT email FROM public.members;
SELECT email AS value FROM public.members;
SELECT encode(convert_to(email, 'UTF8'), 'hex') AS value FROM public.members;
SELECT count(email) FROM public.members;
```

A redacted result or model refusal does not prove a database denial. Check the database's permission error, exercise relevant views and functions, and confirm that an allowed query still works after a refusal. Recheck after new grants, role memberships, routines or schema changes. If approved aggregates over protected fields are required, expose narrowly reviewed backend outputs rather than restoring unrestricted source access.

## What was tested

A disposable PostgreSQL 17.9 fixture, compiled JanuScope and Postgres MCP 0.3.0 passed **30 allowed analytical calls** and returned backend permission errors for **87 protected-source calls** across three fresh MCP sessions. Independent direct-role checks confirmed SQLSTATE `42501` for the denied cases.

The cases covered raw fields, aliases, hex/base64, fragments, JSON and whole rows, predicates, data-dependent errors, unsafe views and function overloads. A new protected column, table and function were added between sessions and remained inaccessible. Allowed analytical results and subsequent recovery were preserved. Tests also demonstrated how broad table, inherited, `PUBLIC`, view and function grants can defeat a narrower column grant before those paths were removed from the fixture.

Schema injection included permitted columns and excluded protected column definitions in this fixture. Database catalogs may still reveal relation names or comments. Review schema scope and defaults. Set `dbSchema.includeComments: false` to omit table, view and column comments from automatic schema injection. This setting does not prevent an upstream metadata tool or an explicit catalog query from retrieving comments; keep protected values out of schema metadata.

These results establish the tested permission boundary. They do not establish universal non-inference, eliminate timing or query-plan channels, audit a production database, or validate other backends. PostgreSQL itself documents limits to information isolation even with security-barrier views. [Rules and privileges](https://www.postgresql.org/docs/17/rules-privileges.html).

## Other MCP backends

Apply the same principle with backend-specific permissions: restrict filesystem roots and readable files, API resources and scopes, or database objects available to the credential. If the upstream cannot restrict a protected field, expose a separately reviewed data surface that omits it. Retain JanuScope's request checks, response rules and explicit instructions as additional controls, and validate the actual upstream connection before making a stronger privacy claim.
