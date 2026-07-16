import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import StatTiles from './StatTiles.jsx';

describe('StatTiles', () => {
  it('derives counts from the given contacts/campaigns props', () => {
    const contacts = [{ id: '1' }, { id: '2' }];
    const campaigns = [
      { status: 'pending' },
      { status: 'processing' },
      { status: 'sent' },
      { status: 'sent' },
      { status: 'failed' },
      { status: 'partial' },
    ];
    render(<StatTiles contacts={contacts} campaigns={campaigns} />);

    expect(screen.getByText('Contacts').nextSibling).toHaveTextContent('2');
    expect(screen.getByText('Queued').nextSibling).toHaveTextContent('2');
    expect(screen.getByText('Sent').nextSibling).toHaveTextContent('2');
    expect(screen.getByText('Failed').nextSibling).toHaveTextContent('2');
  });

  it('renders zeros for empty lists', () => {
    render(<StatTiles contacts={[]} campaigns={[]} />);
    expect(screen.getByText('Contacts').nextSibling).toHaveTextContent('0');
  });
});
