// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { memo, useCallback, useState } from 'react';
import type { JSX } from 'react';

import { AxoButton } from '../../axo/AxoButton.dom.tsx';
import { AxoConfirmDialog } from '../../axo/AxoConfirmDialog.dom.tsx';
import { tw } from '../../axo/tw.dom.tsx';
import type { TrukiSupervisorStateName } from '../../../app/truki/trukiBridgeProtocol.std.ts';
import type { LocalizerType } from '../../types/Util.std.ts';
import { getTrukiAccountStatusKind } from '../../util/trukiAccountState.std.ts';
import type { TrukiAccountStatusKind } from '../../util/trukiAccountState.std.ts';
import type { TrukiLoginView } from '../../util/trukiLoginFlow.std.ts';
import { trukiNeedsBanRiskDialog } from '../../util/trukiLoginFlow.std.ts';
import { TrukiBanRiskDialog } from './TrukiBanRiskDialog.dom.tsx';
import { TrukiBridgedConversationBanner } from './TrukiBridgedConversationBanner.dom.tsx';
import { TrukiLoginFlow } from './TrukiLoginFlow.dom.tsx';

export type TrukiConnectedAccount = Readonly<{
  loginId: string;
  network: string;
  remoteName: string;
  state: string;
  reason?: string;
}>;

export type TrukiConnectedAccountsProps = Readonly<{
  i18n: LocalizerType;
  bridgeState: TrukiSupervisorStateName;
  networks: ReadonlyArray<Readonly<{ id: string; name: string }>>;
  accounts: ReadonlyArray<TrukiConnectedAccount>;
  // The open login per network; a network without one shows its row only.
  loginViews: Readonly<Record<string, TrukiLoginView>>;
  busyNetworks: ReadonlyArray<string>;
  banRiskAccepted: ReadonlyArray<string> | undefined;
  onAcceptBanRisk: (network: string) => void;
  onConnect: (network: string) => void;
  onLogout: (network: string, loginId: string) => void;
  onChooseFlow: (network: string, flowId: string) => void;
  onSubmitInput: (
    network: string,
    input: Readonly<Record<string, string>>
  ) => void;
  onOpenCookieLogin: (network: string) => void;
  onCancelLogin: (network: string) => void;
  onRetryLogin: (network: string) => void;
  onRestartBridge: () => void;
}>;

const STATUS_KEYS = {
  connected: 'icu:TrukiConnectedAccounts__Status--connected',
  connecting: 'icu:TrukiConnectedAccounts__Status--connecting',
  'logged-out': 'icu:TrukiConnectedAccounts__Status--logged-out',
  error: 'icu:TrukiConnectedAccounts__Status--error',
} as const satisfies Record<TrukiAccountStatusKind, string>;

function StatusDot({
  kind,
}: Readonly<{ kind: TrukiAccountStatusKind }>): JSX.Element {
  return (
    <span
      aria-hidden
      className={tw(
        'inline-block size-2 shrink-0 rounded-full',
        kind === 'connected' && 'bg-affirmative',
        kind === 'connecting' && 'bg-secondary',
        kind === 'logged-out' && 'bg-warning-bright',
        kind === 'error' && 'bg-destructive'
      )}
    />
  );
}

function BridgeBanner({
  i18n,
  bridgeState,
  hasAccounts,
  onRestartBridge,
}: Readonly<{
  i18n: LocalizerType;
  bridgeState: TrukiSupervisorStateName;
  hasAccounts: boolean;
  onRestartBridge: () => void;
}>): JSX.Element | null {
  if (bridgeState === 'unavailable') {
    return (
      <TrukiBridgedConversationBanner
        i18n={i18n}
        tone="error"
        text={i18n('icu:TrukiConnectedAccounts__SecureStorageUnavailable')}
      />
    );
  }
  if (bridgeState === 'starting') {
    return (
      <TrukiBridgedConversationBanner
        i18n={i18n}
        tone="info"
        text={i18n('icu:TrukiConnectedAccounts__BridgeStarting')}
      />
    );
  }
  // 'stopped' with no accounts is simply nothing enabled yet.
  if (
    bridgeState === 'gave-up' ||
    bridgeState === 'backoff' ||
    (bridgeState === 'stopped' && hasAccounts)
  ) {
    return (
      <TrukiBridgedConversationBanner
        i18n={i18n}
        tone="warning"
        text={i18n('icu:TrukiConnectedAccounts__BridgeStopped')}
        action={{
          label: i18n('icu:TrukiConnectedAccounts__Restart'),
          onClick: onRestartBridge,
        }}
      />
    );
  }
  return null;
}

// Settings > Connected accounts (spec §5.1): one section per network with
// its accounts, Connect / Log out, and the network's login when one is open.
export const TrukiConnectedAccounts = memo(function TrukiConnectedAccounts({
  i18n,
  bridgeState,
  networks,
  accounts,
  loginViews,
  busyNetworks,
  banRiskAccepted,
  onAcceptBanRisk,
  onConnect,
  onLogout,
  onChooseFlow,
  onSubmitInput,
  onOpenCookieLogin,
  onCancelLogin,
  onRetryLogin,
  onRestartBridge,
}: TrukiConnectedAccountsProps): JSX.Element {
  const [banRiskFor, setBanRiskFor] = useState<
    Readonly<{ id: string; name: string }> | undefined
  >();
  const [logoutOf, setLogoutOf] = useState<
    Readonly<{ network: string; name: string; loginId: string }> | undefined
  >();

  const handleConnect = useCallback(
    (network: Readonly<{ id: string; name: string }>) => {
      if (trukiNeedsBanRiskDialog(banRiskAccepted, network.id)) {
        setBanRiskFor(network);
      } else {
        onConnect(network.id);
      }
    },
    [banRiskAccepted, onConnect]
  );
  const handleBanRiskConfirm = useCallback(
    (network: string) => {
      setBanRiskFor(undefined);
      onAcceptBanRisk(network);
      onConnect(network);
    },
    [onAcceptBanRisk, onConnect]
  );
  const handleBanRiskCancel = useCallback(() => setBanRiskFor(undefined), []);

  const handleLogoutOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setLogoutOf(undefined);
    }
  }, []);
  const handleLogoutConfirm = useCallback(() => {
    if (logoutOf) {
      onLogout(logoutOf.network, logoutOf.loginId);
    }
    setLogoutOf(undefined);
  }, [logoutOf, onLogout]);

  const canConnect = bridgeState !== 'unavailable';

  return (
    <div
      data-testid="TrukiConnectedAccounts"
      className={tw('flex flex-col gap-6 pb-6')}
    >
      <p className={tw('m-0 type-body-medium text-secondary')}>
        {i18n('icu:TrukiConnectedAccounts__Description')}
      </p>
      <BridgeBanner
        i18n={i18n}
        bridgeState={bridgeState}
        hasAccounts={accounts.length > 0}
        onRestartBridge={onRestartBridge}
      />
      {networks.map(network => {
        const networkAccounts = accounts.filter(a => a.network === network.id);
        const view = loginViews[network.id];
        const busy = busyNetworks.includes(network.id);
        return (
          <section
            key={network.id}
            aria-label={network.name}
            className={tw('flex flex-col gap-3')}
          >
            <div className={tw('flex items-center gap-3')}>
              <h2
                className={tw(
                  'm-0 grow type-title-small font-semibold text-primary'
                )}
              >
                {network.name}
              </h2>
              {!view && (
                <AxoButton.Root
                  variant="subtle-primary"
                  size="md"
                  disabled={!canConnect}
                  onClick={() => handleConnect(network)}
                >
                  {i18n('icu:TrukiConnectedAccounts__Connect')}
                </AxoButton.Root>
              )}
            </div>
            {networkAccounts.length === 0 && !view && (
              <span className={tw('type-body-medium text-secondary')}>
                {i18n('icu:TrukiConnectedAccounts__NotConnected')}
              </span>
            )}
            {networkAccounts.map(account => {
              const kind = getTrukiAccountStatusKind(account.state);
              return (
                <div
                  key={account.loginId}
                  className={tw(
                    'flex items-center gap-3 rounded-lg border border-primary px-4 py-3'
                  )}
                >
                  <div className={tw('flex min-w-0 grow flex-col gap-0.5')}>
                    <span
                      className={tw('truncate type-body-large text-primary')}
                    >
                      {account.remoteName || account.loginId}
                    </span>
                    <span
                      className={tw(
                        'flex items-center gap-1.5 type-body-small text-secondary'
                      )}
                    >
                      <StatusDot kind={kind} />
                      {i18n(STATUS_KEYS[kind])}
                    </span>
                    {account.reason && kind !== 'connected' && (
                      <span
                        className={tw(
                          'type-caption wrap-break-word text-secondary'
                        )}
                      >
                        {account.reason}
                      </span>
                    )}
                  </div>
                  <AxoButton.Root
                    variant="subtle-destructive"
                    size="sm"
                    onClick={() =>
                      setLogoutOf({
                        network: network.id,
                        name: network.name,
                        loginId: account.loginId,
                      })
                    }
                  >
                    {i18n('icu:TrukiConnectedAccounts__LogOut')}
                  </AxoButton.Root>
                </div>
              );
            })}
            {view && (
              <TrukiLoginFlow
                i18n={i18n}
                networkName={network.name}
                view={view}
                busy={busy}
                onChooseFlow={flowId => onChooseFlow(network.id, flowId)}
                onSubmitInput={input => onSubmitInput(network.id, input)}
                onOpenCookieLogin={() => onOpenCookieLogin(network.id)}
                onCancel={() => onCancelLogin(network.id)}
                onRetry={() => onRetryLogin(network.id)}
              />
            )}
          </section>
        );
      })}
      <TrukiBanRiskDialog
        i18n={i18n}
        network={banRiskFor}
        onConfirm={handleBanRiskConfirm}
        onCancel={handleBanRiskCancel}
      />
      <AxoConfirmDialog.Root
        open={logoutOf !== undefined}
        onOpenChange={handleLogoutOpenChange}
        title={i18n('icu:TrukiConnectedAccounts__LogOutTitle', {
          network: logoutOf?.name ?? '',
        })}
        description={i18n('icu:TrukiConnectedAccounts__LogOutDescription')}
      >
        <AxoConfirmDialog.Cancel />
        <AxoConfirmDialog.Action
          variant="strong-destructive"
          onClick={handleLogoutConfirm}
        >
          {i18n('icu:TrukiConnectedAccounts__LogOut')}
        </AxoConfirmDialog.Action>
      </AxoConfirmDialog.Root>
    </div>
  );
});
