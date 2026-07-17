import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SendStatusBanner from './SendStatusBanner.jsx';

describe('SendStatusBanner', () => {
  it('renders nothing when everything is normal', () => {
    const { container } = render(
      <SendStatusBanner providerConfigured dryRun={false} testOverrideActive={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('warns when no SMS provider is configured', () => {
    render(<SendStatusBanner providerConfigured={false} dryRun={false} testOverrideActive={false} />);
    expect(screen.getByText(/No SMS provider configured/)).toBeInTheDocument();
  });

  it('warns when dry run is active', () => {
    render(<SendStatusBanner providerConfigured dryRun testOverrideActive={false} />);
    expect(screen.getByText(/Test mode \(dry run\)/)).toBeInTheDocument();
  });

  it('warns when a test number override is active', () => {
    render(<SendStatusBanner providerConfigured dryRun={false} testOverrideActive />);
    expect(screen.getByText(/test number override is active/)).toBeInTheDocument();
  });

  it('shows all applicable warnings at once', () => {
    render(<SendStatusBanner providerConfigured={false} dryRun testOverrideActive />);
    expect(screen.getByText(/No SMS provider configured/)).toBeInTheDocument();
    expect(screen.getByText(/Test mode \(dry run\)/)).toBeInTheDocument();
    expect(screen.getByText(/test number override is active/)).toBeInTheDocument();
  });
});
