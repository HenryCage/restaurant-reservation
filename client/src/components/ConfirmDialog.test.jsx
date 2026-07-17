import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ConfirmDialog from './ConfirmDialog.jsx';

describe('ConfirmDialog', () => {
  it('renders nothing when closed', () => {
    render(<ConfirmDialog open={false} title="Delete?" message="Are you sure?" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByText('Delete?')).not.toBeInTheDocument();
  });

  it('renders the title and message when open', () => {
    render(<ConfirmDialog open title="Delete Ada?" message="This cannot be undone." onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('Delete Ada?')).toBeInTheDocument();
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
  });

  it('calls onConfirm when the confirm button is clicked', () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog open title="Delete?" message="Sure?" confirmLabel="Delete" onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when the cancel button is clicked', () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="Delete?" message="Sure?" onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('exposes dialog semantics for assistive tech', () => {
    render(<ConfirmDialog open title="Delete Ada?" message="This cannot be undone." onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Delete Ada?');
    expect(dialog).toHaveAccessibleDescription('This cannot be undone.');
  });

  it('moves focus to the Cancel button on open', () => {
    render(<ConfirmDialog open title="Delete?" message="Sure?" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('calls onCancel when Escape is pressed', () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="Delete?" message="Sure?" onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when the backdrop is clicked', () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="Delete?" message="Sure?" onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('dialog').parentElement);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not dismiss when clicking inside the dialog card itself', () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="Delete?" message="Sure?" onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Sure?'));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('traps Tab focus between the two buttons', () => {
    render(<ConfirmDialog open title="Delete?" message="Sure?" confirmLabel="Delete" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    const confirmButton = screen.getByRole('button', { name: 'Delete' });
    expect(cancelButton).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(confirmButton).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(cancelButton).toHaveFocus();
  });

  it('removes the keydown listener on close/unmount (no stale Escape handling)', () => {
    const onCancel = vi.fn();
    const { rerender } = render(<ConfirmDialog open title="Delete?" message="Sure?" onConfirm={vi.fn()} onCancel={onCancel} />);
    rerender(<ConfirmDialog open={false} title="Delete?" message="Sure?" onConfirm={vi.fn()} onCancel={onCancel} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
