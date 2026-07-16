import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { createApiClient } from './api.js';
import LoginScreen from './screens/LoginScreen.jsx';
import ChangePasswordScreen from './screens/ChangePasswordScreen.jsx';
import TenantPickerScreen from './screens/TenantPickerScreen.jsx';
import TenantManagementScreen from './screens/TenantManagementScreen.jsx';
import DashboardScreen from './screens/DashboardScreen.jsx';

// loading -> login -> (changePassword) -> (tenantPicker, superadmin only) -> dashboard
//                                                    \-> tenantManagement (superadmin only) -/
function App() {
  const [screen, setScreen] = useState('loading');
  const [sessionMessage, setSessionMessage] = useState(null);
  const [chosenTenantId, setChosenTenantId] = useState(null);
  // Distinguishes "never logged in" (first /auth/me check, 401 is normal --
  // no notice) from "was logged in, session died" (401 later -- show the
  // notice) for the same onUnauthorized callback.
  const wasAuthenticatedRef = useRef(false);

  const handleUnauthorized = useCallback(() => {
    if (wasAuthenticatedRef.current) {
      setSessionMessage('Session expired, please log in again.');
    }
    wasAuthenticatedRef.current = false;
    setChosenTenantId(null);
    setScreen('login');
  }, []);

  // Only a superadmin's requests need tenantId attached; recreated when the
  // chosen tenant changes (cheap -- just a closure factory, no side effects).
  //
  // baseUrl: empty (relative paths) in production, where server.js serves
  // this SPA and the API from the same origin. In local dev, client/ runs
  // on its own Vite server (a different origin/port from the backend), so
  // relative fetches would hit Vite itself and 404 -- VITE_API_BASE_URL
  // (set in client/.env, see client/.env.example) points them at the real
  // backend instead.
  const api = useMemo(
    () =>
      createApiClient({
        baseUrl: import.meta.env.VITE_API_BASE_URL ?? '',
        onUnauthorized: handleUnauthorized,
        tenantId: chosenTenantId ?? undefined,
      }),
    [handleUnauthorized, chosenTenantId],
  );

  const routeFromMe = useCallback(
    (me) => {
      if (me.mustChangePassword) {
        setScreen('changePassword');
      } else if (me.isSuperadmin && !chosenTenantId) {
        setScreen('tenantPicker');
      } else {
        setScreen('dashboard');
      }
    },
    [chosenTenantId],
  );

  useEffect(() => {
    let cancelled = false;
    api
      .get('/auth/me')
      .then((me) => {
        if (cancelled) return;
        wasAuthenticatedRef.current = true;
        routeFromMe(me);
      })
      .catch(() => {
        // A 401 already routed to 'login' via onUnauthorized; nothing else to do.
      });
    return () => {
      cancelled = true;
    };
    // Intentionally only on mount -- re-checking on every `api` identity
    // change (e.g. after picking a tenant) would be redundant, since the
    // screens that change `chosenTenantId` already set the next screen themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleLogin(me) {
    wasAuthenticatedRef.current = true;
    setSessionMessage(null);
    routeFromMe(me);
  }

  async function handlePasswordChanged() {
    const me = await api.get('/auth/me');
    routeFromMe(me);
  }

  function handleTenantPicked(tenantId) {
    setChosenTenantId(tenantId);
    setScreen('dashboard');
  }

  function handleManageTenants() {
    setScreen('tenantManagement');
  }

  function handleBackFromTenantManagement() {
    setScreen('tenantPicker');
  }

  async function handleLogout() {
    try {
      await api.post('/auth/logout', {});
    } catch {
      // Even if the request itself fails, still return to the login screen.
    }
    wasAuthenticatedRef.current = false;
    setChosenTenantId(null);
    setSessionMessage(null);
    setScreen('login');
  }

  if (screen === 'loading') {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-slate-300 border-t-slate-900 rounded-full animate-spin" />
      </div>
    );
  }

  if (screen === 'changePassword') {
    return <ChangePasswordScreen api={api} onChanged={handlePasswordChanged} />;
  }

  if (screen === 'tenantPicker') {
    return <TenantPickerScreen onPick={handleTenantPicked} onManageTenants={handleManageTenants} />;
  }

  if (screen === 'tenantManagement') {
    return <TenantManagementScreen api={api} onBack={handleBackFromTenantManagement} />;
  }

  if (screen === 'dashboard') {
    return <DashboardScreen api={api} onLogout={handleLogout} />;
  }

  return <LoginScreen api={api} onLogin={handleLogin} initialError={sessionMessage} />;
}

export default App;
