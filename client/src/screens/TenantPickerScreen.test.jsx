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
});
