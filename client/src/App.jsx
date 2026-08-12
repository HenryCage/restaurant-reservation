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

const menuItems = [
  {
    id: 1,
    name: "Pan-Seared Chilean Sea Bass",
    category: "Main Course",
    price: "$42",
    description: "Wild-caught sea bass over saffron risotto, heirloom vegetables, and fresh herb drizzle.",
    tag: "Chef's Choice",
    image: "/images/seabass.png"
  },
  {
    id: 2,
    name: "Prime Truffle Ribeye Steak",
    category: "Main Course",
    price: "$54",
    description: "USDA Prime 14oz ribeye infused with black truffle butter, charred asparagus, and potato puree.",
    tag: "Signature",
    image: "/images/steak.png"
  },
  {
    id: 3,
    name: "Wild Forest Mushroom Risotto",
    category: "Main Course",
    price: "$32",
    description: "Arborio rice, roasted porcini, aged parmesan, truffle oil, and crisp sage leaves.",
    tag: "Vegetarian",
    image: "/images/risotto.png"
  },
  {
    id: 4,
    name: "Artisanal Chocolate Fondant",
    category: "Dessert",
    price: "$16",
    description: "Warm Belgian dark chocolate cake with a molten center, paired with Madagascar vanilla bean gelato.",
    tag: "Decadent",
    image: "/images/fondant.png"
  }
];

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

  function scrollToReservation() {
    const el = document.getElementById('reservation');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
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
    <div className="min-h-screen bg-stone-50 font-sans text-zinc-900 selection:bg-emerald-200 selection:text-emerald-950">
      {/* Header / Navigation */}
      <header className="sticky top-0 z-50 border-b border-stone-200/80 bg-white/90 backdrop-blur-md shadow-xs">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <a href="#" className="flex items-center gap-3 group">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-700 text-amber-300 font-bold shadow-md shadow-emerald-700/20 group-hover:scale-105 transition-transform">
              <svg className="h-6 w-6 fill-current" viewBox="0 0 24 24">
                <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
              </svg>
            </div>
            <div>
              <span className="text-xl font-serif font-bold tracking-tight text-zinc-900">L'Étoile</span>
              <span className="ml-2 text-xs font-semibold uppercase tracking-widest text-emerald-700">Bistro</span>
            </div>
          </a>

          <nav className="hidden items-center gap-8 text-sm font-medium text-stone-600 md:flex">
            <a href="#about" className="transition hover:text-emerald-700">About Us</a>
            <a href="#menu" className="transition hover:text-emerald-700">Menu</a>
            <a href="#ambiance" className="transition hover:text-emerald-700">Ambiance</a>
            <a href="#hours" className="transition hover:text-emerald-700">Hours & Location</a>
          </nav>

          <button
            onClick={scrollToReservation}
            className="rounded-full bg-emerald-700 px-5 py-2.5 text-xs font-bold uppercase tracking-wider text-white shadow-md shadow-emerald-700/20 transition hover:bg-emerald-800 active:scale-95 cursor-pointer"
          >
            Book a Reservation
          </button>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative overflow-hidden border-b border-stone-200 bg-gradient-to-b from-amber-50/70 via-stone-50 to-stone-100/50 py-16 lg:py-24">
        <div className="mx-auto max-w-6xl px-6">
          <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
            <div className="flex flex-col gap-6">
              <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3.5 py-1 text-xs font-semibold uppercase tracking-widest text-emerald-800 w-fit">
                <span>★ 4.9</span>
                <span className="text-emerald-300">•</span>
                <span>Michelin Recommended 2026</span>
              </div>
              
              <h1 className="font-serif text-4xl font-normal leading-tight text-zinc-900 sm:text-5xl lg:text-6xl">
                An Extraordinary <span className="italic text-emerald-800">Culinary</span> Journey
              </h1>
              
              <p className="text-lg text-stone-600 leading-relaxed max-w-xl">
                Immerse yourself in authentic contemporary dining curated by world-class chefs. Every dish is a celebration of fresh seasonal ingredients and artisanal craftsmanship.
              </p>

              <div className="flex flex-wrap items-center gap-4 pt-2">
                <button
                  onClick={scrollToReservation}
                  className="rounded-full bg-emerald-700 px-7 py-3.5 text-sm font-bold uppercase tracking-wider text-white shadow-lg shadow-emerald-700/25 transition hover:bg-emerald-800 active:scale-95 cursor-pointer"
                >
                  Book a Reservation
                </button>

                <a
                  href="#menu"
                  className="rounded-full border border-stone-300 bg-white px-7 py-3.5 text-sm font-semibold tracking-wider text-stone-700 transition hover:border-stone-400 hover:bg-stone-100 shadow-xs"
                >
                  View Menu
                </a>
              </div>

              <div className="grid grid-cols-3 gap-6 pt-6 border-t border-stone-200 text-center sm:text-left">
                <div>
                  <p className="text-2xl font-serif font-bold text-emerald-800">15+</p>
                  <p className="text-xs text-stone-500 uppercase tracking-wider mt-1">Years of Excellence</p>
                </div>
                <div>
                  <p className="text-2xl font-serif font-bold text-emerald-800">100%</p>
                  <p className="text-xs text-stone-500 uppercase tracking-wider mt-1">Organic & Local</p>
                </div>
                <div>
                  <p className="text-2xl font-serif font-bold text-emerald-800">80+</p>
                  <p className="text-xs text-stone-500 uppercase tracking-wider mt-1">Curated Wines</p>
                </div>
              </div>
            </div>

            <div className="relative">
              <div className="absolute -inset-1.5 rounded-3xl bg-amber-200/40 blur-xl opacity-70" />
              <div className="relative overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-xl">
                <img
                  src="/images/hero.png"
                  alt="L'Étoile Dining Experience"
                  className="h-[400px] w-full object-cover transition transform hover:scale-105 duration-700"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-zinc-950/70 via-transparent to-transparent" />
                <div className="absolute bottom-6 left-6 right-6 p-4 rounded-xl bg-white/95 backdrop-blur-md border border-stone-200 shadow-md">
                  <p className="text-xs font-bold uppercase tracking-wider text-emerald-800">Chef's Signature Experience</p>
                  <p className="text-sm text-stone-700 mt-1">Seasonal 7-course tasting menu paired with artisanal reserve wines.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* About Section */}
      <section id="about" className="py-20 border-b border-stone-200 bg-white">
        <div className="mx-auto max-w-6xl px-6">
          <div className="max-w-3xl mx-auto text-center flex flex-col items-center gap-4">
            <span className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-700">Our Story</span>
            <h2 className="font-serif text-3xl sm:text-4xl text-zinc-900 font-normal">Crafted with Passion & Precision</h2>
            <p className="text-stone-600 text-base leading-7">
              Founded in 2011, L'Étoile Bistro brings modern French-Mediterranean gastronomy to your table. We work directly with local organic farmers and sustainable fisheries to source pristine ingredients, transformed through modern wood-fire cooking techniques.
            </p>
          </div>
        </div>
      </section>

      {/* Menu Highlights Section */}
      <section id="menu" className="py-20 border-b border-stone-200 bg-stone-50">
        <div className="mx-auto max-w-6xl px-6">
          <div className="flex flex-col items-center text-center gap-3 mb-12">
            <span className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-700">Culinary Selection</span>
            <h2 className="font-serif text-3xl sm:text-4xl text-zinc-900 font-normal">Signature Dishes</h2>
            <p className="text-stone-600 text-sm max-w-lg">A sampling of our most beloved seasonal creations prepared daily by Executive Chef Jean-Luc.</p>
          </div>

          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {menuItems.map((item) => (
              <div key={item.id} className="flex flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-xs transition hover:shadow-lg hover:border-emerald-600/40 group">
                {item.image ? (
                  <div className="h-48 overflow-hidden relative bg-stone-100">
                    <img 
                      src={item.image} 
                      alt={item.name} 
                      onError={(e) => {
                        // Fallback from .png to .jpg or vice versa if file extension differs
                        if (e.target.src.endsWith('.png')) {
                          e.target.src = e.target.src.replace('.png', '.jpg');
                        } else if (e.target.src.endsWith('.jpg')) {
                          e.target.src = e.target.src.replace('.jpg', '.png');
                        }
                      }}
                      className="h-full w-full object-cover transition transform group-hover:scale-105 duration-500" 
                    />
                    <span className="absolute top-3 right-3 rounded-full bg-emerald-700 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white shadow-xs">
                      {item.tag}
                    </span>
                  </div>
                ) : (
                  <div className="h-48 bg-amber-50/50 flex items-center justify-center relative p-6 text-center border-b border-stone-100">
                    <span className="text-xs font-semibold text-stone-500 uppercase tracking-widest">{item.category}</span>
                    <span className="absolute top-3 right-3 rounded-full bg-emerald-700 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
                      {item.tag}
                    </span>
                  </div>
                )}
                <div className="flex flex-1 flex-col justify-between p-5">
                  <div>
                    <div className="flex items-baseline justify-between gap-2">
                      <h3 className="font-serif text-base font-medium text-zinc-900 group-hover:text-emerald-800 transition">{item.name}</h3>
                      <span className="font-serif text-base font-bold text-emerald-800">{item.price}</span>
                    </div>
                    <p className="mt-2 text-xs text-stone-600 leading-relaxed">{item.description}</p>
                  </div>
                  <button
                    onClick={scrollToReservation}
                    className="mt-4 text-xs font-semibold text-emerald-700 hover:text-emerald-900 flex items-center gap-1 transition cursor-pointer"
                  >
                    Reserve for this dish &rarr;
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Ambiance & Atmosphere */}
      <section id="ambiance" className="py-20 border-b border-stone-200 bg-white">
        <div className="mx-auto max-w-6xl px-6">
          <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
            <div className="flex flex-col gap-5">
              <span className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-700">The Setting</span>
              <h2 className="font-serif text-3xl sm:text-4xl text-zinc-900 font-normal">Warm Atmosphere & Intimate Elegance</h2>
              <p className="text-stone-600 text-base leading-7">
                Whether you're celebrating a romantic evening, a corporate dinner, or a relaxed gathering with close friends, our dining hall offers soft ambient lighting, bespoke velvet seating, and exceptional acoustics.
              </p>
              <ul className="grid gap-3 text-sm text-stone-700 pt-2">
                <li className="flex items-center gap-3">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-emerald-800 text-xs font-bold">✓</span>
                  Private Dining Rooms for up to 24 guests
                </li>
                <li className="flex items-center gap-3">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-emerald-800 text-xs font-bold">✓</span>
                  Heated Garden Terrace seating
                </li>
                <li className="flex items-center gap-3">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-emerald-800 text-xs font-bold">✓</span>
                  Live Acoustic Jazz every Thursday & Saturday evening
                </li>
              </ul>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-2xl border border-stone-200 bg-amber-50/40 p-6 flex flex-col justify-between h-48 shadow-xs">
                <span className="text-3xl">🍷</span>
                <div>
                  <h4 className="font-serif font-semibold text-zinc-900">Wine Cellar</h4>
                  <p className="text-xs text-stone-600 mt-1">Curated pairings by certified sommeliers.</p>
                </div>
              </div>
              <div className="rounded-2xl border border-stone-200 bg-amber-50/40 p-6 flex flex-col justify-between h-48 shadow-xs">
                <span className="text-3xl">🔥</span>
                <div>
                  <h4 className="font-serif font-semibold text-zinc-900">Open Kitchen</h4>
                  <p className="text-xs text-stone-600 mt-1">Watch live culinary wizardry at our Chef's counter.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Hours & Location Section */}
      <section id="hours" className="py-20 border-b border-stone-200 bg-stone-50">
        <div className="mx-auto max-w-6xl px-6">
          <div className="grid gap-10 md:grid-cols-2">
            <div className="rounded-2xl border border-stone-200 bg-white p-8 flex flex-col justify-between shadow-sm">
              <div>
                <span className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-700">Opening Hours</span>
                <h3 className="font-serif text-2xl text-zinc-900 mt-2 mb-6">Service Schedule</h3>
                <div className="space-y-4 text-sm text-stone-700">
                  <div className="flex justify-between border-b border-stone-100 pb-3">
                    <span className="font-medium">Monday – Thursday</span>
                    <span className="text-emerald-800 font-semibold">5:00 PM – 10:30 PM</span>
                  </div>
                  <div className="flex justify-between border-b border-stone-100 pb-3">
                    <span className="font-medium">Friday – Saturday</span>
                    <span className="text-emerald-800 font-semibold">12:00 PM – 11:30 PM</span>
                  </div>
                  <div className="flex justify-between border-b border-stone-100 pb-3">
                    <span className="font-medium">Sunday Brunch & Dinner</span>
                    <span className="text-emerald-800 font-semibold">11:00 AM – 10:00 PM</span>
                  </div>
                </div>
              </div>
              <p className="text-xs text-stone-500 mt-6">Walk-ins welcome based on availability. Reservations recommended.</p>
            </div>

            <div className="rounded-2xl border border-stone-200 bg-white p-8 flex flex-col justify-between shadow-sm">
              <div>
                <span className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-700">Visit Us</span>
                <h3 className="font-serif text-2xl text-zinc-900 mt-2 mb-6">Location & Contact</h3>
                <div className="space-y-4 text-sm text-stone-700">
                  <div>
                    <p className="font-semibold text-zinc-900">Address</p>
                    <p className="text-stone-600 mt-1">142 Gourmet Boulevard, Culinary Quarter, Cityville</p>
                  </div>
                  <div>
                    <p className="font-semibold text-zinc-900">Direct Contact</p>
                    <p className="text-stone-600 mt-1">+1 (555) 839-2041 / reservations@letoilebistro.com</p>
                  </div>
                  <div>
                    <p className="font-semibold text-zinc-900">Valet Parking</p>
                    <p className="text-stone-600 mt-1">Complimentary valet parking available at main entrance.</p>
                  </div>
                </div>
              </div>
              <button
                onClick={scrollToReservation}
                className="mt-6 w-full rounded-xl bg-stone-100 border border-stone-300 py-3 text-xs font-bold uppercase tracking-wider text-emerald-800 hover:bg-stone-200 hover:border-emerald-600/40 transition cursor-pointer"
              >
                Book Your Table Now
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Reservation Section */}
      <section id="reservation" className="scroll-mt-20 py-20 bg-stone-100">
        <div className="mx-auto flex w-full max-w-5xl items-center px-5 py-4">
          <section className="grid w-full gap-8 lg:grid-cols-[0.85fr_1.15fr] bg-white border border-stone-200 p-8 sm:p-10 rounded-3xl shadow-xl">
            <div className="flex flex-col justify-center gap-4">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">Reservations</p>
              <h1 className="text-4xl font-serif font-normal leading-tight text-zinc-950 sm:text-5xl">Reserve a table</h1>
              <p className="max-w-md text-base leading-7 text-stone-600">
                Pick a time, leave your phone number, and the system will send the confirmation by SMS.
              </p>
              
              <div className="mt-4 p-4 rounded-xl bg-emerald-50/80 border border-emerald-200 text-xs text-emerald-900 space-y-2">
                <div className="flex items-center gap-2 text-emerald-800 font-semibold">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Instant SMS Confirmation
                </div>
                <p>You will receive an automated text confirmation as soon as your table is secured.</p>
              </div>
            </div>

            <form
              onSubmit={handleSubmit}
              className="w-full max-w-full rounded-2xl border border-stone-200 bg-stone-50 p-6 shadow-sm sm:p-8"
              aria-label="Reservation form"
            >
              <div className="grid gap-5 sm:grid-cols-2 w-full max-w-full">
                <label className="flex flex-col gap-2 min-w-0 w-full text-xs font-semibold uppercase tracking-wider text-stone-700 sm:col-span-2">
                  Name
                  <input
                    name="name"
                    value={form.name}
                    onChange={updateField}
                    required
                    placeholder="Jane Doe"
                    className="h-11 w-full min-w-0 box-border rounded-lg border border-stone-300 bg-white px-3.5 text-base text-zinc-950 placeholder:text-stone-400 outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
                    autoComplete="name"
                  />
                </label>

                <label className="flex flex-col gap-2 min-w-0 w-full text-xs font-semibold uppercase tracking-wider text-stone-700">
                  Country code
                  <input
                    name="countryCode"
                    value={form.countryCode}
                    onChange={updateField}
                    required
                    inputMode="numeric"
                    className="h-11 w-full min-w-0 box-border rounded-lg border border-stone-300 bg-white px-3.5 text-base text-zinc-950 outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
                  />
                </label>

                <label className="flex flex-col gap-2 min-w-0 w-full text-xs font-semibold uppercase tracking-wider text-stone-700">
                  Phone number
                  <input
                    name="phone"
                    value={form.phone}
                    onChange={updateField}
                    required
                    inputMode="tel"
                    placeholder="08012345678"
                    className="h-11 w-full min-w-0 box-border rounded-lg border border-stone-300 bg-white px-3.5 text-base text-zinc-950 placeholder:text-stone-400 outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
                    autoComplete="tel"
                  />
                </label>

                <label className="flex flex-col gap-2 min-w-0 w-full text-xs font-semibold uppercase tracking-wider text-stone-700">
                  Party size
                  <input
                    name="partySize"
                    value={form.partySize}
                    onChange={updateField}
                    required
                    min="1"
                    max="30"
                    type="number"
                    className="h-11 w-full min-w-0 box-border rounded-lg border border-stone-300 bg-white px-3.5 text-base text-zinc-950 outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
                  />
                </label>

                <label className="flex flex-col gap-2 min-w-0 w-full max-w-full text-xs font-semibold uppercase tracking-wider text-stone-700 overflow-hidden">
                  Date and time
                  <input
                    name="reservationTime"
                    value={form.reservationTime}
                    onChange={updateField}
                    required
                    type="datetime-local"
                    className="h-11 w-full min-w-0 max-w-full box-border rounded-lg border border-stone-300 bg-white px-3 text-base text-zinc-950 outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100 [color-scheme:light]"
                  />
                </label>

                <label className="flex flex-col gap-2 min-w-0 w-full text-xs font-semibold uppercase tracking-wider text-stone-700 sm:col-span-2">
                  Notes
                  <textarea
                    name="notes"
                    value={form.notes}
                    onChange={updateField}
                    rows="3"
                    placeholder="Special requests, dietary preferences, or seating choices..."
                    className="resize-none w-full min-w-0 box-border rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-base text-zinc-950 placeholder:text-stone-400 outline-none transition focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
                  />
                </label>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="mt-6 h-12 w-full rounded-xl bg-zinc-950 px-4 text-xs font-bold uppercase tracking-wider text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-stone-400 shadow-md cursor-pointer"
              >
                {submitting ? 'Sending...' : 'Book reservation'}
              </button>

              {status.message ? (
                <p
                  className={
                    status.type === 'success'
                      ? 'mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800'
                      : status.type === 'warning'
                        ? 'mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800'
                        : 'mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800'
                  }
                  role="status"
                >
                  {status.message}
                </p>
              ) : null}
            </form>
          </section>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-stone-200 bg-white py-10 text-center text-xs text-stone-500">
        <div className="mx-auto max-w-6xl px-6 flex flex-col items-center justify-between gap-4 sm:flex-row">
          <p>© 2026 L'Étoile Bistro. All rights reserved.</p>
          <div className="flex items-center gap-6 text-stone-600">
            <a href="#about" className="hover:text-emerald-700 transition">About</a>
            <a href="#menu" className="hover:text-emerald-700 transition">Menu</a>
            <a href="#hours" className="hover:text-emerald-700 transition">Hours</a>
            <button onClick={scrollToReservation} className="hover:text-emerald-700 transition cursor-pointer">Reservations</button>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;


