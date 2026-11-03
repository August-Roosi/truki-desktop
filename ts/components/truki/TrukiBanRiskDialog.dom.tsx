// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { memo, useCallback } from 'react';
import type { JSX } from 'react';

import { AxoConfirmDialog } from '../../axo/AxoConfirmDialog.dom.tsx';
import type { LocalizerType } from '../../types/Util.std.ts';

export type TrukiBanRiskDialogProps = Readonly<{
  i18n: LocalizerType;
  // The network about to be connected; closed when undefined.
  network: Readonly<{ id: string; name: string }> | undefined;
  onConfirm: (networkId: string) => void;
  onCancel: () => void;
}>;

// Shown before the first connect per network: the network may suspend
// accounts that use unofficial clients (spec §5.2).
export const TrukiBanRiskDialog = memo(function TrukiBanRiskDialog({
  i18n,
  network,
  onConfirm,
  onCancel,
}: TrukiBanRiskDialogProps): JSX.Element {
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onCancel();
      }
    },
    [onCancel]
  );
  const handleConfirm = useCallback(() => {
    if (network) {
      onConfirm(network.id);
    }
  }, [network, onConfirm]);

  const name = network?.name ?? '';
  return (
    <AxoConfirmDialog.Root
      open={network !== undefined}
      onOpenChange={handleOpenChange}
      title={i18n('icu:TrukiConnectedAccounts__BanRiskTitle', {
        network: name,
      })}
      description={i18n('icu:TrukiConnectedAccounts__BanRiskDescription', {
        network: name,
      })}
    >
      <AxoConfirmDialog.Cancel />
      <AxoConfirmDialog.Action
        variant="strong-destructive"
        onClick={handleConfirm}
      >
        {i18n('icu:TrukiConnectedAccounts__BanRiskConfirm')}
      </AxoConfirmDialog.Action>
    </AxoConfirmDialog.Root>
  );
});
