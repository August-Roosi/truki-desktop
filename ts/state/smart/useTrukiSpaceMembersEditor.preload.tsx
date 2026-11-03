// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { useCallback, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { useSelector, useStore } from 'react-redux';

import { TrukiSpaceOtherNetworks } from '../../components/preferences/chatFolders/TrukiSpaceOtherNetworks.dom.tsx';
import {
  getTrukiSpaceMembers,
  saveTrukiMembersForNewSpace,
  setTrukiSpaceMembers,
} from '../../services/trukiSpaceMembers.preload.ts';
import type {
  ChatFolderId,
  ChatFolderParams,
} from '../../types/ChatFolder.std.ts';
import { isSameChatFolderParams } from '../../types/ChatFolder.std.ts';
import { CurrentChatFolders } from '../../types/CurrentChatFolders.std.ts';
import {
  EMPTY_TRUKI_SPACE_MEMBERS,
  getTrukiConnectedNetworks,
  isSameTrukiSpaceMembers,
  type TrukiSpaceMembersEntry,
} from '../../util/trukiSpaceMembersEdit.std.ts';
import { getCurrentChatFolders } from '../selectors/chatFolders.std.ts';
import {
  getTrukiBridge,
  getTrukiChatList,
} from '../selectors/trukiBridge.std.ts';
import { getIntl } from '../selectors/user.std.ts';
import type { StateType } from '../reducer.preload.ts';

type CreateFn = (params: ChatFolderParams, showToastOnSuccess: boolean) => void;
type UpdateFn = (id: ChatFolderId, params: ChatFolderParams) => void;

// The Space editor's bridged-chat membership: the section to render, whether
// it has unsaved changes, and create/update handlers that persist it with the
// Space. A new Space's members are written only once its folder exists in
// redux, or the left pane's prune effect would delete them.
export function useTrukiSpaceMembersEditor(options: {
  existingChatFolderId: ChatFolderId | null;
  initChatFolderParams: ChatFolderParams;
  onCreateChatFolder: CreateFn;
  onUpdateChatFolder: UpdateFn;
}): Readonly<{
  section: JSX.Element;
  dirty: boolean;
  onCreateChatFolder: CreateFn;
  onUpdateChatFolder: UpdateFn;
}> {
  const {
    existingChatFolderId,
    initChatFolderParams,
    onCreateChatFolder,
    onUpdateChatFolder,
  } = options;

  const i18n = useSelector(getIntl);
  const chats = useSelector(getTrukiChatList);
  const bridge = useSelector(getTrukiBridge);
  const store = useStore<StateType>();

  const [initial] = useState<TrukiSpaceMembersEntry>(
    () =>
      (existingChatFolderId != null
        ? getTrukiSpaceMembers()[existingChatFolderId]
        : undefined) ?? EMPTY_TRUKI_SPACE_MEMBERS
  );
  const [draft, setDraft] = useState<TrukiSpaceMembersEntry>(initial);
  const dirty = !isSameTrukiSpaceMembers(initial, draft);

  const networks = useMemo(
    () => getTrukiConnectedNetworks(bridge.accounts, bridge.networks),
    [bridge.accounts, bridge.networks]
  );

  const handleCreate = useCallback<CreateFn>(
    (params, showToastOnSuccess) => {
      if (!dirty) {
        onCreateChatFolder(params, showToastOnSuccess);
        return;
      }
      const folderIds = (): ReadonlyArray<string> =>
        CurrentChatFolders.toSortedArray(
          getCurrentChatFolders(store.getState())
        ).map(folder => folder.id);
      void saveTrukiMembersForNewSpace({
        knownFolderIds: new Set(folderIds()),
        create: () => onCreateChatFolder(params, showToastOnSuccess),
        getFolderIds: folderIds,
        subscribe: callback => store.subscribe(callback),
        members: draft,
      });
    },
    [dirty, draft, onCreateChatFolder, store]
  );

  const handleUpdate = useCallback<UpdateFn>(
    (id, params) => {
      if (dirty) {
        void setTrukiSpaceMembers(id, draft);
      }
      // Members-only changes leave the Space itself as it was.
      if (!isSameChatFolderParams(initChatFolderParams, params)) {
        onUpdateChatFolder(id, params);
      }
    },
    [dirty, draft, initChatFolderParams, onUpdateChatFolder]
  );

  const section = (
    <TrukiSpaceOtherNetworks
      i18n={i18n}
      networks={networks}
      chats={chats}
      value={draft}
      onChange={setDraft}
    />
  );

  return {
    section,
    dirty,
    onCreateChatFolder: handleCreate,
    onUpdateChatFolder: handleUpdate,
  };
}
