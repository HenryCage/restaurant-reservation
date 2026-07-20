import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TenantFormScreen from './TenantFormScreen.jsx';

function makeApi(overrides = {}) {
  return { get: vi.fn(), post: vi.fn(), patch: vi.fn(), ...overrides };
}

function fillCoreFields({ id = true } = {}) {
  if (id) fireEvent.change(screen.getByLabelText('Tenant ID'), { target: { value: 'swift-logistics' } });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Swift Logistics' } });
  fireEvent.change(screen.getByLabelText('Sheet ID'), { target: { value: 'sheet-1' } });
  fireEvent.change(screen.getByLabelText('Sender ID'), { target: { value: 'SwiftLog' } });
  fireEvent.change(screen.getByLabelText('Status 1'), { target: { value: 'Out for delivery' } });
  fireEvent.change(screen.getByLabelText('Template 1'), { target: { value: 'Hi {name}' } });
}

describe('TenantFormScreen', () => {
  it('create mode: submits the expected payload including id, calls onSaved', async () => {
    const api = makeApi({ post: vi.fn().mockResolvedValue({ id: 'swift-logistics' }) });
    const onSaved = vi.fn();
    render(<TenantFormScreen api={api} mode="create" tenant={null} onSaved={onSaved} onCancel={vi.fn()} />);

    fillCoreFields();
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith(
      '/api/tenants',
      expect.objectContaining({
        id: 'swift-logistics',
        name: 'Swift Logistics',
        sheetId: 'sheet-1',
        senderId: 'SwiftLog',
        notifyStatuses: ['Out for delivery'],
        templates: { 'Out for delivery': 'Hi {name}' },
      }),
    );
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('edit mode: id field is disabled, submits via PATCH to the tenant-specific path', async () => {
    const tenant = {
      id: 'swift-logistics',
      name: 'Swift Logistics',
      active: true,
      sheetId: 'sheet-1',
      sheetName: 'Orders',
      senderId: 'SwiftLog',
      channel: 'dnd',
      testNumber: '',
      notifyStatuses: ['Out for delivery'],
      templates: { 'Out for delivery': 'Hi {name}' },
    };
    const api = makeApi({ patch: vi.fn().mockResolvedValue(tenant) });
    const onSaved = vi.fn();
    render(<TenantFormScreen api={api} mode="edit" tenant={tenant} onSaved={onSaved} onCancel={vi.fn()} />);

    expect(screen.getByLabelText('Tenant ID')).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Swift Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(api.patch).toHaveBeenCalledWith(
      '/api/tenants/swift-logistics',
      expect.objectContaining({ name: 'Swift Renamed' }),
    );
    expect(api.post).not.toHaveBeenCalled();
  });

  it('adds and removes notifyStatus/template rows', () => {
    render(<TenantFormScreen api={makeApi()} mode="create" tenant={null} onSaved={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByLabelText('Status 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /add status/i }));
    expect(screen.getByLabelText('Status 2')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: /remove/i })[0]);
    expect(screen.queryByLabelText('Status 2')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Status 1')).toBeInTheDocument();
  });

  it('renders a server conflict error without crashing', async () => {
    const api = makeApi({ post: vi.fn().mockRejectedValue(new Error('"senderId" is shared with another active tenant')) });
    render(<TenantFormScreen api={api} mode="create" tenant={null} onSaved={vi.fn()} onCancel={vi.fn()} />);

    fillCoreFields();
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText('"senderId" is shared with another active tenant')).toBeInTheDocument();
  });

  it('calls onCancel when Cancel is clicked', () => {
    const onCancel = vi.fn();
    render(<TenantFormScreen api={makeApi()} mode="create" tenant={null} onSaved={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  describe('Default Country Code field', () => {
    it('defaults to "(use global default)" (empty) and submits empty when untouched', async () => {
      const api = makeApi({ post: vi.fn().mockResolvedValue({ id: 'swift-logistics' }) });
      const onSaved = vi.fn();
      render(<TenantFormScreen api={api} mode="create" tenant={null} onSaved={onSaved} onCancel={vi.fn()} />);

      expect(screen.getByLabelText('Default Country Code').value).toBe('');

      fillCoreFields();
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(api.post).toHaveBeenCalledWith('/api/tenants', expect.objectContaining({ defaultCountryCode: '' }));
    });

    it('submits the selected override', async () => {
      const api = makeApi({ post: vi.fn().mockResolvedValue({ id: 'swift-logistics' }) });
      const onSaved = vi.fn();
      render(<TenantFormScreen api={api} mode="create" tenant={null} onSaved={onSaved} onCancel={vi.fn()} />);

      fillCoreFields();
      fireEvent.change(screen.getByLabelText('Default Country Code'), { target: { value: '370' } });
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(api.post).toHaveBeenCalledWith('/api/tenants', expect.objectContaining({ defaultCountryCode: '370' }));
    });

    it('edit mode: prefills from the existing tenant', () => {
      const tenant = { id: 'swift-logistics', defaultCountryCode: '370' };
      render(<TenantFormScreen api={makeApi()} mode="edit" tenant={tenant} onSaved={vi.fn()} onCancel={vi.fn()} />);
      expect(screen.getByLabelText('Default Country Code').value).toBe('370');
    });
  });

  describe('SMS provider fields', () => {
    it('shows only the selected provider\'s fields', () => {
      render(<TenantFormScreen api={makeApi()} mode="create" tenant={null} onSaved={vi.fn()} onCancel={vi.fn()} />);

      expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('SMS Provider'), { target: { value: 'termii' } });
      expect(screen.getByLabelText('API Key')).toBeInTheDocument();
      expect(screen.getByLabelText('Base URL')).toBeInTheDocument();
      expect(screen.queryByLabelText('Username')).not.toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('SMS Provider'), { target: { value: 'twilio' } });
      expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Account SID')).toBeInTheDocument();
      expect(screen.getByLabelText('Auth Token')).toBeInTheDocument();
      expect(screen.getByLabelText('From Number')).toBeInTheDocument();
    });

    it('create mode: submits smsProvider/smsCredentials built from the visible fields', async () => {
      const api = makeApi({ post: vi.fn().mockResolvedValue({ id: 'swift-logistics' }) });
      const onSaved = vi.fn();
      render(<TenantFormScreen api={api} mode="create" tenant={null} onSaved={onSaved} onCancel={vi.fn()} />);

      fillCoreFields();
      fireEvent.change(screen.getByLabelText('SMS Provider'), { target: { value: 'termii' } });
      fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'my-api-key' } });
      fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://acct.termii.com' } });
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(api.post).toHaveBeenCalledWith(
        '/api/tenants',
        expect.objectContaining({
          smsProvider: 'termii',
          smsCredentials: { apiKey: 'my-api-key', baseUrl: 'https://acct.termii.com' },
        }),
      );
    });

    it('edit mode: a secret field starts blank with the masked value shown as helper text', () => {
      const tenant = {
        id: 'swift-logistics',
        name: 'Swift Logistics',
        active: true,
        sheetId: 'sheet-1',
        sheetName: 'Orders',
        senderId: 'SwiftLog',
        channel: 'dnd',
        testNumber: '',
        notifyStatuses: ['Out for delivery'],
        templates: { 'Out for delivery': 'Hi {name}' },
        smsProvider: 'termii',
        smsCredentials: { apiKey: '••••ab12', baseUrl: 'https://acct.termii.com' },
      };
      render(<TenantFormScreen api={makeApi()} mode="edit" tenant={tenant} onSaved={vi.fn()} onCancel={vi.fn()} />);

      expect(screen.getByLabelText('API Key').value).toBe('');
      expect(screen.getByLabelText('API Key')).not.toBeRequired();
      expect(screen.getByText(/Currently set:/)).toBeInTheDocument();
      expect(screen.getByText('••••ab12')).toBeInTheDocument();
      // The non-secret field prefills with the real (unmasked, already-safe) value.
      expect(screen.getByLabelText('Base URL').value).toBe('https://acct.termii.com');
    });

    it('edit mode: leaving the secret field blank keeps smsCredentials.apiKey empty in the payload (server interprets as keep-existing)', async () => {
      const tenant = {
        id: 'swift-logistics',
        name: 'Swift Logistics',
        active: true,
        sheetId: 'sheet-1',
        sheetName: 'Orders',
        senderId: 'SwiftLog',
        channel: 'dnd',
        testNumber: '',
        notifyStatuses: ['Out for delivery'],
        templates: { 'Out for delivery': 'Hi {name}' },
        smsProvider: 'termii',
        smsCredentials: { apiKey: '••••ab12', baseUrl: 'https://acct.termii.com' },
      };
      const api = makeApi({ patch: vi.fn().mockResolvedValue(tenant) });
      const onSaved = vi.fn();
      render(<TenantFormScreen api={api} mode="edit" tenant={tenant} onSaved={onSaved} onCancel={vi.fn()} />);

      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(api.patch).toHaveBeenCalledWith(
        '/api/tenants/swift-logistics',
        expect.objectContaining({ smsCredentials: { apiKey: '', baseUrl: 'https://acct.termii.com' } }),
      );
    });

    it('switching provider in edit mode requires the new provider\'s fields (no stale helper text)', () => {
      const tenant = {
        id: 'swift-logistics',
        smsProvider: 'termii',
        smsCredentials: { apiKey: '••••ab12', baseUrl: 'https://acct.termii.com' },
      };
      render(<TenantFormScreen api={makeApi()} mode="edit" tenant={tenant} onSaved={vi.fn()} onCancel={vi.fn()} />);

      fireEvent.change(screen.getByLabelText('SMS Provider'), { target: { value: 'twilio' } });
      expect(screen.queryByText(/Currently set:/)).not.toBeInTheDocument();
      expect(screen.getByLabelText('Auth Token')).toBeRequired();
      expect(screen.getByLabelText('Auth Token').value).toBe('');
    });
  });

  describe('Google credential fields', () => {
    it('create mode: submits googleServiceAccountEmail/googlePrivateKey from the visible fields', async () => {
      const api = makeApi({ post: vi.fn().mockResolvedValue({ id: 'swift-logistics' }) });
      const onSaved = vi.fn();
      render(<TenantFormScreen api={api} mode="create" tenant={null} onSaved={onSaved} onCancel={vi.fn()} />);

      fillCoreFields();
      fireEvent.change(screen.getByLabelText('Service Account Email'), { target: { value: 'sa@example.com' } });
      fireEvent.change(screen.getByLabelText('Private Key'), { target: { value: 'FAKE-KEY' } });
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(api.post).toHaveBeenCalledWith(
        '/api/tenants',
        expect.objectContaining({ googleServiceAccountEmail: 'sa@example.com', googlePrivateKey: 'FAKE-KEY' }),
      );
    });

    it('edit mode: the email prefills in full (not a secret); the private key starts blank with the masked indicator as helper text', () => {
      const tenant = { id: 'swift-logistics', googleServiceAccountEmail: 'sa@example.com', googlePrivateKey: '(private key set)' };
      render(<TenantFormScreen api={makeApi()} mode="edit" tenant={tenant} onSaved={vi.fn()} onCancel={vi.fn()} />);

      expect(screen.getByLabelText('Service Account Email').value).toBe('sa@example.com');
      expect(screen.getByLabelText('Private Key').value).toBe('');
      expect(screen.getByText(/Currently set:/)).toBeInTheDocument();
      expect(screen.getByText('(private key set)')).toBeInTheDocument();
    });

    it('edit mode: leaving the private key blank submits an empty string (server interprets as keep-existing)', async () => {
      const tenant = {
        id: 'swift-logistics',
        name: 'Swift Logistics',
        sheetId: 'sheet-1',
        senderId: 'SwiftLog',
        notifyStatuses: ['Out for delivery'],
        templates: { 'Out for delivery': 'Hi {name}' },
        googleServiceAccountEmail: 'sa@example.com',
        googlePrivateKey: '(private key set)',
      };
      const api = makeApi({ patch: vi.fn().mockResolvedValue(tenant) });
      const onSaved = vi.fn();
      render(<TenantFormScreen api={api} mode="edit" tenant={tenant} onSaved={onSaved} onCancel={vi.fn()} />);

      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(api.patch).toHaveBeenCalledWith(
        '/api/tenants/swift-logistics',
        expect.objectContaining({ googleServiceAccountEmail: 'sa@example.com', googlePrivateKey: '' }),
      );
    });

    it('no helper text when the tenant has no Google credentials configured yet', () => {
      const tenant = { id: 'swift-logistics', googleServiceAccountEmail: '', googlePrivateKey: '' };
      render(<TenantFormScreen api={makeApi()} mode="edit" tenant={tenant} onSaved={vi.fn()} onCancel={vi.fn()} />);
      expect(screen.queryByText(/Currently set:/)).not.toBeInTheDocument();
    });
  });
});
