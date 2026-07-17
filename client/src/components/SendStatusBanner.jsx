import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';

/**
 * Surfaces the reasons a tenant's messages might not actually be reaching
 * real phones -- no SMS provider configured, DRY_RUN, or a test number
 * override -- all look identical from a tenant user's side ("nothing
 * happened") without this. Pure presentational, like StatTiles: no fetch of
 * its own, renders nothing when everything is normal.
 *
 * @param {{ providerConfigured: boolean, dryRun: boolean, testOverrideActive: boolean }} props
 */
function SendStatusBanner({ providerConfigured, dryRun, testOverrideActive }) {
  if (providerConfigured && !dryRun && !testOverrideActive) return null;

  return (
    <div className="space-y-2">
      {!providerConfigured && (
        <div className="p-4 rounded-xl border flex items-start gap-2.5 text-sm font-medium bg-rose-50 border-rose-200 text-rose-800">
          <ExclamationTriangleIcon className="w-5 h-5 flex-shrink-0" />
          <p>No SMS provider configured -- messages will not be sent. Contact your administrator.</p>
        </div>
      )}
      {dryRun && (
        <div className="p-4 rounded-xl border flex items-start gap-2.5 text-sm font-medium bg-amber-50 border-amber-200 text-amber-800">
          <ExclamationTriangleIcon className="w-5 h-5 flex-shrink-0" />
          <p>Test mode (dry run) is active -- messages are logged but not actually sent.</p>
        </div>
      )}
      {testOverrideActive && (
        <div className="p-4 rounded-xl border flex items-start gap-2.5 text-sm font-medium bg-amber-50 border-amber-200 text-amber-800">
          <ExclamationTriangleIcon className="w-5 h-5 flex-shrink-0" />
          <p>A test number override is active -- messages are being redirected instead of reaching real recipients.</p>
        </div>
      )}
    </div>
  );
}

export default SendStatusBanner;
