import { useState } from 'react';
import UserListScreen from './UserListScreen.jsx';
import UserFormScreen from './UserFormScreen.jsx';

/**
 * Small local navigation wrapper (list <-> create form) -- mirrors
 * TenantManagementScreen's composition, also threading `scope` through to
 * both children and holding the transient just-created temp password until
 * the list screen has shown and dismissed it.
 * @param {{
 *   api: ReturnType<typeof import('../api.js').createApiClient>,
 *   scope: { type: 'tenant', tenantId: string } | { type: 'superadmin' },
 *   onBack: () => void,
 * }} props
 */
function UserManagementScreen({ api, scope, onBack }) {
  const [view, setView] = useState('list'); // 'list' | 'create'
  const [refreshKey, setRefreshKey] = useState(0);
  const [pendingReveal, setPendingReveal] = useState(null);

  function handleCreate() {
    setView('create');
  }

  function handleSaved(result) {
    setPendingReveal({ email: result.user.email, temporaryPassword: result.temporaryPassword });
    setRefreshKey((k) => k + 1);
    setView('list');
  }

  function handleCancel() {
    setView('list');
  }

  if (view === 'create') {
    return <UserFormScreen api={api} scope={scope} onSaved={handleSaved} onCancel={handleCancel} />;
  }

  return (
    <UserListScreen
      api={api}
      scope={scope}
      refreshKey={refreshKey}
      pendingReveal={pendingReveal}
      onDismissPendingReveal={() => setPendingReveal(null)}
      onCreate={handleCreate}
      onBack={onBack}
    />
  );
}

export default UserManagementScreen;
