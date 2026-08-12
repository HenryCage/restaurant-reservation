import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App.jsx';

function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, statusText: 'Status', json: async () => body };
}

beforeEach(() => {
  global.fetch = vi.fn();
});

describe('App reservation form', () => {
  it('renders the public reservation form first', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Reserve a table' })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Reservation form' })).toBeInTheDocument();
  });

  it('posts reservation details and shows the SMS success message', async () => {
    global.fetch.mockResolvedValue(
      jsonResponse(201, {
        reservation: { name: 'Ada' },
        sms: { status: 'sent', error: null },
      }),
    );

    render(<App />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '08012345678' } });
    fireEvent.change(screen.getByLabelText('Party size'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Date and time'), { target: { value: '2026-08-20T19:30' } });
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Window seat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Book reservation' }));

    await screen.findByText(/Reservation received for Ada/);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/reservations',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      }),
    );

    const [, options] = global.fetch.mock.calls[0];
    expect(JSON.parse(options.body)).toMatchObject({
      name: 'Ada',
      phone: '08012345678',
      countryCode: '234',
      partySize: 4,
      reservationTime: '2026-08-20T19:30',
      notes: 'Window seat',
    });
  });

  it('shows the server error when booking fails', async () => {
    global.fetch.mockResolvedValue(jsonResponse(400, { error: 'invalid phone: nope' }));

    render(<App />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: 'nope' } });
    fireEvent.change(screen.getByLabelText('Date and time'), { target: { value: '2026-08-20T19:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Book reservation' }));

    await waitFor(() => expect(screen.getByText('invalid phone: nope')).toBeInTheDocument());
  });
});
