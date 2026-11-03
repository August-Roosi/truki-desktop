// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { memo, useCallback, useEffect, useMemo } from 'react';
import type { JSX, MutableRefObject } from 'react';
import { useSelector } from 'react-redux';

import { PreferencesContent } from '../../components/Preferences.dom.tsx';
import { TrukiConnectedAccounts } from '../../components/truki/TrukiConnectedAccounts.dom.tsx';
import {
  getTrukiLoginView,
  getTrukiPageNetworks,
  trukiWithBanRiskAccepted,
} from '../../util/trukiLoginFlow.std.ts';
import type { TrukiLoginView } from '../../util/trukiLoginFlow.std.ts';
import { drop } from '../../util/drop.std.ts';
import { useItemsActions } from '../ducks/items.preload.ts';
import { useTrukiBridgeActions } from '../ducks/trukiBridge.preload.ts';
import { getItems } from '../selectors/items.dom.ts';
import { getTrukiBridge } from '../selectors/trukiBridge.std.ts';
import { getIntl } from '../selectors/user.std.ts';

export const SmartTrukiConnectedAccounts = memo(
  function SmartTrukiConnectedAccounts(): JSX.Element {
    const i18n = useSelector(getIntl);
    const bridge = useSelector(getTrukiBridge);
    const banRiskAccepted = useSelector(getItems).trukiBridgeBanRiskAccepted;
    const { putItem } = useItemsActions();
    const {
      trukiBridgeStart,
      restartBridge,
      enableNetwork,
      startLogin,
      retryLogin,
      submitLoginInput,
      startCookieLogin,
      cancelLogin,
      logout,
    } = useTrukiBridgeActions();

    // Settings can open before the left pane has started the client.
    useEffect(() => {
      trukiBridgeStart();
    }, [trukiBridgeStart]);

    const { loginViews, busyNetworks } = useMemo(() => {
      const views: Record<string, TrukiLoginView> = {};
      const busy: Array<string> = [];
      for (const [network, attempt] of Object.entries(
        bridge.loginAttempts ?? {}
      )) {
        const view = getTrukiLoginView(attempt, bridge.loginProcesses);
        if (view) {
          views[network] = view;
        }
        if (attempt.busy) {
          busy.push(network);
        }
      }
      return { loginViews: views, busyNetworks: busy };
    }, [bridge.loginAttempts, bridge.loginProcesses]);

    const onAcceptBanRisk = useCallback(
      (network: string) => {
        putItem(
          'trukiBridgeBanRiskAccepted',
          trukiWithBanRiskAccepted(banRiskAccepted, network)
        );
      },
      [banRiskAccepted, putItem]
    );

    return (
      <TrukiConnectedAccounts
        i18n={i18n}
        bridgeState={bridge.bridgeState}
        networks={getTrukiPageNetworks(bridge.networks)}
        accounts={bridge.accounts}
        loginViews={loginViews}
        busyNetworks={busyNetworks}
        banRiskAccepted={banRiskAccepted}
        onAcceptBanRisk={onAcceptBanRisk}
        onConnect={network => drop(enableNetwork(network))}
        onLogout={(network, loginId) => drop(logout(network, loginId))}
        onChooseFlow={(network, flowId) => drop(startLogin(network, flowId))}
        onSubmitInput={(network, input) =>
          drop(submitLoginInput(network, input))
        }
        onOpenCookieLogin={network => drop(startCookieLogin(network))}
        onCancelLogin={network => drop(cancelLogin(network))}
        onRetryLogin={network => drop(retryLogin(network))}
        onRestartBridge={() => drop(restartBridge())}
      />
    );
  }
);

function TitledPage({
  contentsRef,
}: Readonly<{
  contentsRef: MutableRefObject<HTMLDivElement | null>;
}>): JSX.Element {
  const i18n = useSelector(getIntl);
  return (
    <PreferencesContent
      contents={<SmartTrukiConnectedAccounts />}
      contentsRef={contentsRef}
      title={i18n('icu:TrukiConnectedAccounts__Title')}
    />
  );
}

// Preferences' renderTrukiConnectedAccounts render prop.
export function renderTrukiConnectedAccounts({
  contentsRef,
}: Readonly<{
  contentsRef: MutableRefObject<HTMLDivElement | null>;
}>): JSX.Element {
  return <TitledPage contentsRef={contentsRef} />;
}
