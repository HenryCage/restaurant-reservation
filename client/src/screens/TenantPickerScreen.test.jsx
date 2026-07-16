import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TenantPickerScreen from './TenantPickerScreen.jsx';

describe('TenantPickerScreen', () => {
  it('calls onPick with the trimmed input value on submit', () => {
    const onPick = vi.fn();
    render(<TenantPickerScreen onPick={onPick} />);

    fireEvent.change(screen.getByLabelText('Tenant ID'), { target: { value: '  swift-logistics  ' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    expect(onPick).toHaveBeenCalledWith('swift-logistics');
  });

  it('does not call onPick for a whitespace-only value', () => {
    const onPick = vi.fn();
    render(<TenantPickerScreen onPick={onPick} />);

    // Whitespace passes the HTML `required` attribute but is trimmed to
    // empty by the component's own guard -- this exercises that guard
    // directly, rather than relying on jsdom's native validation behavior.
    fireEvent.change(screen.getByLabelText('Tenant ID'), { target: { value: '   ' } });
    fireEvent.submit(screen.getByRole('button', { name: /continue/i }).closest('form'));

    expect(onPick).not.toHaveBeenCalled();
  });

  it('calls onManageTenants when the "Manage tenants" link is clicked', () => {
    const onManageTenants = vi.fn();
    render(<TenantPickerScreen onPick={vi.fn()} onManageTenants={onManageTenants} />);

    fireEvent.click(screen.getByRole('button', { name: /manage tenants/i }));

    expect(onManageTenants).toHaveBeenCalledTimes(1);
  });

  it('calls onManageUsers with the trimmed tenant id when "Manage users" is clicked', () => {
    const onManageUsers = vi.fn();
    render(<TenantPickerScreen onPick={vi.fn()} onManageUsers={onManageUsers} />);

    fireEvent.change(screen.getByLabelText('Tenant ID'), { target: { value: '  swift-logistics  ' } });
    fireEvent.click(screen.getByRole('button', { name: /manage users/i }));

    expect(onManageUsers).toHaveBeenCalledWith('swift-logistics');
  });

  it('does not call onManageUsers for a whitespace-only tenant id', () => {
    const onManageUsers = vi.fn();
    render(<TenantPickerScreen onPick={vi.fn()} onManageUsers={onManageUsers} />);

    fireEvent.change(screen.getByLabelText('Tenant ID'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /manage users/i }));

    expect(onManageUsers).not.toHaveBeenCalled();
  });

  it('calls onManageSuperadmins when the "Manage superadmins" link is clicked', () => {
    const onManageSuperadmins = vi.fn();
    render(<TenantPickerScreen onPick={vi.fn()} onManageSuperadmins={onManageSuperadmins} />);

    fireEvent.click(screen.getByRole('button', { name: /manage superadmins/i }));

    expect(onManageSuperadmins).toHaveBeenCalledTimes(1);
  });
});
