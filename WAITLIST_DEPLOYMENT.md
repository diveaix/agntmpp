# Waitlist Deployment

The waitlist page is served by the same Vite app. When the hostname starts with
`waitlist.`, the app renders the waitlist-only experience.

## Domain

Add `waitlist.agntmpp.xyz` to the same Vercel project as the website.

At your DNS provider, add the record Vercel asks for. Usually this is:

```text
Type: CNAME
Name: waitlist
Value: cname.vercel-dns.com
```

## Database

Create a Supabase table:

```sql
create table if not exists public.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  first_name text,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

## Vercel Environment Variables

Add these to the Vercel project:

```text
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

Keep the service role key server-side only. Do not expose it as a `VITE_` variable.

## Endpoint

The form posts to:

```text
/api/waitlist
```

The endpoint upserts by email, so duplicate signups are safe.
