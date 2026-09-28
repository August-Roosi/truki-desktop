// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';

import {
  CHANGE_LOCATION,
  getEmptyState,
  reducer,
} from '../../../state/ducks/nav.std.ts';
import {
  NavTab,
  ProfileEditorPage,
  SettingsPage,
} from '../../../types/Nav.std.ts';
import type { Location } from '../../../types/Nav.std.ts';

function navigate(state: ReturnType<typeof getEmptyState>, location: Location) {
  return reducer(state, {
    type: CHANGE_LOCATION,
    payload: { selectedLocation: location },
  });
}

describe('Truki nav reducer', () => {
  it('remembers the location used to enter settings', () => {
    const callsLocation: Location = { tab: NavTab.Calls };
    const settingsLocation: Location = {
      tab: NavTab.Settings,
      details: {
        page: SettingsPage.Profile,
        state: ProfileEditorPage.None,
      },
    };

    const callsState = navigate(getEmptyState(), callsLocation);
    const settingsState = navigate(callsState, settingsLocation);

    assert.deepEqual(settingsState.lastNonSettingsLocation, callsLocation);
  });

  it('keeps the entry location while navigating within settings', () => {
    const storiesLocation: Location = { tab: NavTab.Stories };
    const profileLocation: Location = {
      tab: NavTab.Settings,
      details: {
        page: SettingsPage.Profile,
        state: ProfileEditorPage.None,
      },
    };
    const generalLocation: Location = {
      tab: NavTab.Settings,
      details: { page: SettingsPage.General },
    };

    const storiesState = navigate(getEmptyState(), storiesLocation);
    const profileState = navigate(storiesState, profileLocation);
    const generalState = navigate(profileState, generalLocation);

    assert.deepEqual(generalState.lastNonSettingsLocation, storiesLocation);
  });
});
