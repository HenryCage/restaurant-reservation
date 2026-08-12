import { useMemo, useState } from 'react';
import { createApiClient } from './api.js';

const initialForm = {
  name: '',
  phone: '',
  countryCode: '234',
  partySize: '2',
  reservationTime: '',
  notes: '',
};

function App() {
  const [form, setForm] = useState(initialForm);
  const [status, setStatus] = useState({ type: 'idle', message: '' });
  const [submitting, setSubmitting] = useState(false);

  const api = useMemo(
    () =>
      createApiClient({
        baseUrl: import.meta.env.VITE_API_BASE_URL ?? '',
      }),
    [],
  );

  function updateField(event) {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setStatus({ type: 'idle', message: '' });

    try {
      const tenantId = import.meta.env.VITE_RESERVATION_TENANT_ID;
      const body = {
        ...form,
        partySize: Number(form.partySize),
        ...(tenantId ? { tenantId } : {}),
      };
      const result = await api.post('/api/reservations', body);
      const smsNote =
        result.sms?.status === 'sent' || result.sms?.status === 'dry-run'
          ? 'A confirmation text has been queued.'
          : 'Your booking was saved, but the confirmation text did not send.';
      setStatus({
        type: result.sms?.status === 'failed' ? 'warning' : 'success',
        message: `Reservation received for ${result.reservation.name}. ${smsNote}`,
      });
      setForm(initialForm);
    } catch (err) {
      setStatus({ type: 'error', message: err?.message ?? 'Could not create the reservation.' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-zinc-100 text-zinc-950">
      <div className="mx-auto flex min-h-screen w-full max-w-5xl items-center px-5 py-8">
        <section className="grid w-full gap-6 lg:grid-cols-[0.85fr_1.15fr]">
          <div className="flex flex-col justify-center gap-4">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">Reservations</p>
            <h1 className="text-4xl font-semibold leading-tight sm:text-5xl">Reserve a table</h1>
            <p className="max-w-md text-base leading-7 text-zinc-600">
              Pick a time, leave your phone number, and the system will send the confirmation by SMS.
            </p>
          </div>

          <form
            onSubmit={handleSubmit}
            className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm sm:p-6"
            aria-label="Reservation form"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-2 text-sm font-medium text-zinc-700 sm:col-span-2">
                Name
                <input
                  name="name"
                  value={form.name}
                  onChange={updateField}
                  required
                  className="h-11 rounded-md border border-zinc-300 px-3 text-base text-zinc-950 outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
                  autoComplete="name"
                />
              </label>

              <label className="grid gap-2 text-sm font-medium text-zinc-700">
                Country code
                <input
                  name="countryCode"
                  value={form.countryCode}
                  onChange={updateField}
                  required
                  inputMode="numeric"
                  className="h-11 rounded-md border border-zinc-300 px-3 text-base text-zinc-950 outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
                />
              </label>

              <label className="grid gap-2 text-sm font-medium text-zinc-700">
                Phone number
                <input
                  name="phone"
                  value={form.phone}
                  onChange={updateField}
                  required
                  inputMode="tel"
                  className="h-11 rounded-md border border-zinc-300 px-3 text-base text-zinc-950 outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
                  autoComplete="tel"
                />
              </label>

              <label className="grid gap-2 text-sm font-medium text-zinc-700">
                Party size
                <input
                  name="partySize"
                  value={form.partySize}
                  onChange={updateField}
                  required
                  min="1"
                  max="30"
                  type="number"
                  className="h-11 rounded-md border border-zinc-300 px-3 text-base text-zinc-950 outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
                />
              </label>

              <label className="grid gap-2 text-sm font-medium text-zinc-700">
                Date and time
                <input
                  name="reservationTime"
                  value={form.reservationTime}
                  onChange={updateField}
                  required
                  type="datetime-local"
                  className="h-11 rounded-md border border-zinc-300 px-3 text-base text-zinc-950 outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
                />
              </label>

              <label className="grid gap-2 text-sm font-medium text-zinc-700 sm:col-span-2">
                Notes
                <textarea
                  name="notes"
                  value={form.notes}
                  onChange={updateField}
                  rows="3"
                  className="resize-none rounded-md border border-zinc-300 px-3 py-2 text-base text-zinc-950 outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
                />
              </label>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="mt-5 h-11 w-full rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-zinc-400"
            >
              {submitting ? 'Sending...' : 'Book reservation'}
            </button>

            {status.message ? (
              <p
                className={
                  status.type === 'success'
                    ? 'mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800'
                    : status.type === 'warning'
                      ? 'mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800'
                      : 'mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800'
                }
                role="status"
              >
                {status.message}
              </p>
            ) : null}
          </form>
        </section>
      </div>
    </main>
  );
}

export default App;
