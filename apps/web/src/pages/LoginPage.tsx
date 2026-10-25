import { useQuery } from '@tanstack/react-query';
import { KeyRound, LogIn } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api, ApiError } from '@/lib/api';
import { queryClient } from '@/lib/queries';
import { Avatar, Button, Field, Input } from '@/components/ui';

type AuthConfig = { sso: boolean; devLogin: boolean; breakglass: boolean };

export function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const returnTo = params.get('returnTo') ?? '/';
  const error = params.get('error');
  const { data: cfg } = useQuery({ queryKey: ['auth-config'], queryFn: () => api.get<AuthConfig>('/auth/config') });
  const { data: devUsers } = useQuery({
    queryKey: ['dev-users'],
    queryFn: () => api.get<Array<{ id: string; displayName: string; email: string; role: string }>>('/auth/dev-users'),
    enabled: !!cfg?.devLogin,
  });

  const done = async () => {
    queryClient.clear();
    navigate(returnTo.startsWith('/') ? returnTo : '/', { replace: true });
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-subtle p-4">
      <div className="w-full max-w-sm rounded-2xl border border-app bg-app p-6 shadow-sm">
        <div className="mb-6 flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="size-8" />
          <h1 className="text-lg font-semibold">Projects</h1>
        </div>
        {error && <div className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{errorText(error)}</div>}

        {cfg?.sso && (
          <Button variant="primary" className="h-10 w-full" onClick={() => (location.href = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`)}>
            <LogIn className="size-4" /> Sign in with Microsoft
          </Button>
        )}
        {cfg && !cfg.sso && !cfg.devLogin && !cfg.breakglass && (
          <p className="text-sm text-muted">Single sign-on isn't configured yet. An admin can set it up under Admin → Integrations, using the break-glass account.</p>
        )}

        {cfg?.devLogin && (
          <div className="mt-6">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">Dev login</div>
            <div className="space-y-1">
              {devUsers?.map((u) => (
                <button key={u.id} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover-bg"
                  onClick={async () => { await api.post('/auth/dev-login', { userId: u.id }); await done(); }}>
                  <Avatar user={u} size={24} />
                  <span className="flex-1">{u.displayName}</span>
                  <span className="text-xs text-subtle">{u.role}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {cfg?.breakglass && <BreakglassForm onDone={done} />}
      </div>
    </div>
  );
}

function BreakglassForm({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <button className="mt-6 inline-flex items-center gap-1 text-xs text-muted hover:text-app" onClick={() => setOpen(true)}>
        <KeyRound className="size-3.5" /> Break-glass admin login
      </button>
    );
  }
  return (
    <form className="mt-6 space-y-3 border-t border-app pt-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr('');
        try {
          await api.post('/auth/local', { email, password, totp: totp || undefined });
          onDone();
        } catch (ex) {
          if (ex instanceof ApiError && (ex.body as { totpRequired?: boolean })?.totpRequired) setNeedTotp(true);
          setErr(ex instanceof Error ? ex.message : 'Login failed');
        } finally {
          setBusy(false);
        }
      }}>
      <Field label="Email"><Input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></Field>
      <Field label="Password"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
      {needTotp && <Field label="Authenticator code"><Input inputMode="numeric" value={totp} onChange={(e) => setTotp(e.target.value)} autoFocus /></Field>}
      {err && <div className="text-sm text-red-600">{err}</div>}
      <Button type="submit" variant="primary" className="w-full" loading={busy}>Sign in</Button>
    </form>
  );
}

function errorText(code: string) {
  if (code === 'expired') return 'The sign-in took too long. Please try again.';
  if (code === 'sso_not_configured') return 'Single sign-on is not configured.';
  return code;
}
