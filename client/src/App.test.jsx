import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App.jsx';

describe('App (scaffold placeholder)', () => {
  it('renders the heading', () => {
    render(<App />);
    expect(screen.getByText('SMS Dispatch — Dashboard')).toBeInTheDocument();
  });
});
