# Theme

## Compact token summary

- Product style: Signal Desktop / Axo, neutral surfaces, restrained blue accent, high-contrast semantic labels.
- Main surfaces: `--axo-color-surface-primary` for content and `--axo-color-surface-secondary` for navigation sidebars.
- Navigation states: `--axo-color-fill-primary` for hover, `--axo-color-fill-primary-pressed` for selected/pressed.
- Labels: `--axo-color-label-primary`, `--axo-color-label-secondary`, `--axo-color-label-accent`, and destructive/on-color variants.
- Borders: `--axo-color-border-primary` separates rail/sidebar/content.
- Type: system sans stack via Axo font tokens; title-medium for sidebar headings, body styles for labels.
- Spacing: 4px-oriented scale; navigation hit targets use 8-12px radii and compact 4-16px gaps.
- Sidebar: legacy `$NavTabs__width: 64px`; left pane widths come from `leftPaneWidth.std.ts`.
- Motion: preserve existing React Aria focus and selected states; navigation rearrangement should not add decorative animation.
- Accessibility: keep keyboard focus rings, forced-colors behavior, screen-reader labels, and tab semantics.

## Raw Tailwind entry

```css
@import 'tailwindcss' source(none);
@import '../ts/axo/_tailwind.css';

@source '../ts';
@source '../test';
@source '../.storybook';
@source '../*.{html,js}';
@source '../stylesheets/**/*.scss';


```

## Raw Axo colors

```css
/**
 * Copyright 2025 Signal Messenger, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Reset
 * ----------------------------------------------------------------------------
 */

@theme {
  --color-*: initial; /* reset defaults */
  --color-transparent: transparent;
}

/**
 * Brand
 * ----------------------------------------------------------------------------
 */

@theme {
  --axo-color-brand-primary: #3b45fd;
}

/**
 * Labels
 * ----------------------------------------------------------------------------
 * Text & Icons
 */

/* Omitting transparency modifiers for now, they should hopefully not be necessary within the color system */
/* color: --alpha(--value(--axo-color-label-*) / --modifier(integer)); */

@utility text-* {
  /* Text/icons should use label colors */
  color: --value(--axo-color-label-*);
}

/* prettier-ignore */
@theme {
  --axo-color-label-primary:     light-dark(--alpha(#000000 / 90%), --alpha(#ffffff / 90%));
  --axo-color-label-secondary:   light-dark(--alpha(#000000 / 60%), --alpha(#ffffff / 60%));
  --axo-color-label-placeholder: light-dark(--alpha(#000000 / 35%), --alpha(#ffffff / 35%));
  --axo-color-label-disabled:    light-dark(--alpha(#000000 / 25%), --alpha(#ffffff / 25%));
}

/* prettier-ignore */
@layer theme {
  @media (prefers-contrast: more) {
    :root {
      --axo-color-label-primary:     light-dark(#000000, #ffffff);
      --axo-color-label-secondary:   light-dark(--alpha(#000000 / 70%), --alpha(#ffffff / 70%));
      --axo-color-label-placeholder: light-dark(--alpha(#000000 / 50%), --alpha(#ffffff / 50%));
      --axo-color-label-disabled:    light-dark(--alpha(#000000 / 40%), --alpha(#ffffff / 40%));
    }
  }
}

/**
 * Labels (On Color)
 * ----------------------------------------------------------------------------
 */

/* prettier-ignore */
@theme {
  --axo-color-label-primary-oncolor:     light-dark(#ffffff, --alpha(#ffffff / 90%));
  --axo-color-label-secondary-oncolor:   light-dark(--alpha(#ffffff / 80%), --alpha(#ffffff / 70%));
  --axo-color-label-placeholder-oncolor: light-dark(--alpha(#ffffff / 45%), --alpha(#ffffff / 45%));
  --axo-color-label-disabled-oncolor:    light-dark(--alpha(#ffffff / 35%), --alpha(#ffffff / 35%));
}

/* prettier-ignore */
@layer theme {
  @media (prefers-contrast: more) {
    :root {
      --axo-color-label-primary-oncolor:     light-dark(#ffffff, #ffffff);
      --axo-color-label-secondary-oncolor:   light-dark(--alpha(#ffffff / 90%), --alpha(#ffffff / 90%));
      --axo-color-label-placeholder-oncolor: light-dark(--alpha(#ffffff / 60%), --alpha(#ffffff / 60%));
      --axo-color-label-disabled-oncolor:    light-dark(--alpha(#ffffff / 50%), --alpha(#ffffff / 50%));
    }
  }
}

/**
 * Labels (On Bright Colors)
 * ----------------------------------------------------------------------------
 */

/* prettier-ignore */
@theme {
  --axo-color-label-primary-onbright:     light-dark(--alpha(#000000 / 90%), --alpha(#000000 / 90%));
  --axo-color-label-secondary-onbright:   light-dark(--alpha(#000000 / 70%), --alpha(#000000 / 70%));
  --axo-color-label-placeholder-onbright: light-dark(--alpha(#000000 / 45%), --alpha(#000000 / 45%));
  --axo-color-label-disabled-onbright:    light-dark(--alpha(#000000 / 35%), --alpha(#000000 / 35%));
}

/* prettier-ignore */
@layer theme {
  @media (prefers-contrast: more) {
    :root {
      --axo-color-label-primary-onbright:     light-dark(#000000, #000000);
      --axo-color-label-secondary-onbright:   light-dark(--alpha(#000000 / 80%), --alpha(#000000 / 80%));
      --axo-color-label-placeholder-onbright: light-dark(--alpha(#000000 / 60%), --alpha(#000000 / 60%));
      --axo-color-label-disabled-onbright:    light-dark(--alpha(#000000 / 50%), --alpha(#000000 / 50%));
    }
  }
}

/**
 * Labels (Inverted)
 * ----------------------------------------------------------------------------
 */

/* prettier-ignore */
@theme {
  --axo-color-label-primary-inverted:     light-dark(--alpha(#ffffff / 90%), --alpha(#000000 / 90%));
  --axo-color-label-secondary-inverted:   light-dark(--alpha(#ffffff / 60%), --alpha(#000000 / 60%));
  --axo-color-label-placeholder-inverted: light-dark(--alpha(#ffffff / 35%), --alpha(#000000 / 35%));
  --axo-color-label-disabled-inverted:    light-dark(--alpha(#ffffff / 25%), --alpha(#000000 / 25%));
}

/* prettier-ignore */
@layer theme {
  @media (prefers-contrast: more) {
    :root {
      --axo-color-label-primary-inverted:     light-dark(#ffffff, #000000);
      --axo-color-label-secondary-inverted:   light-dark(--alpha(#ffffff / 70%), --alpha(#000000 / 70%));
      --axo-color-label-placeholder-inverted: light-dark(--alpha(#ffffff / 50%), --alpha(#000000 / 50%));
      --axo-color-label-disabled-inverted:    light-dark(--alpha(#ffffff / 40%), --alpha(#000000 / 40%));
    }
  }
}

/**
 * Labels (Colors)
 * ----------------------------------------------------------------------------
 */

/* prettier-ignore */
@theme {
  --axo-color-label-accent:               light-dark(#030ffc, #99a1ff);
  --axo-color-label-accent-disabled:      light-dark(--alpha(#030ffc / 25%), --alpha(#99a1ff / 25%));
  --axo-color-label-affirmative:          light-dark(#00a015, #30d150);
  --axo-color-label-affirmative-disabled: light-dark(--alpha(#00a015 / 25%), --alpha(#30d150 / 25%));
  --axo-color-label-warning:              light-dark(#332900, #ffde5b);
  --axo-color-label-warning-disabled:     light-dark(--alpha(#332900 / 25%), --alpha(#ffde5b / 25%));
  --axo-color-label-safety:               light-dark(#b94b29, #eb977d);
  --axo-color-label-safety-disabled:      light-dark(--alpha(#b94b29 / 25%), --alpha(#eb977d / 25%));
  --axo-color-label-destructive:          light-dark(#f21602, #ff4a3a);
  --axo-color-label-destructive-disabled: light-dark(--alpha(#f21602 / 25%), --alpha(#ff4a3a / 25%));
}

/* prettier-ignore */
@layer theme {
  @media (prefers-contrast: more) {
    :root {
      --axo-color-label-accent:               light-dark(#000cf3, #b6bcff);
      --axo-color-label-accent-disabled:      light-dark(--alpha(#000cf3 / 40%), --alpha(#b6bcff / 40%));
      --axo-color-label-affirmative:          light-dark(#005b0c, #10f53e);
      --axo-color-label-affirmative-disabled: light-dark(--alpha(#005b0c / 40%), --alpha(#10f53e / 40%));
      --axo-color-label-warning:              light-dark(#332900, #ffde5b);
      --axo-color-label-warning-disabled:     light-dark(--alpha(#332900 / 40%), --alpha(#ffde5b / 40%));
      --axo-color-label-safety:               light-dark(#932200, #ffa88d);
      --axo-color-label-safety-disabled:      light-dark(--alpha(#932200 / 40%), --alpha(#ffa88d / 40%));
      --axo-color-label-destructive:          light-dark(#a20d00, #ff9e99);
      --axo-color-label-destructive-disabled: light-dark(--alpha(#a20d00 / 40%), --alpha(#ff9e99 / 40%));
    }
  }
}

/**
 * Surfaces:
 * --------------------------------------------------------------------------
 * Solid colors, usually backgrounds and containers.
 */

@utility bg-surface-* {
  background-color: --value(--axo-color-surface-*);
}

@utility fill-surface-* {
  fill: --value(--axo-color-surface-*);
}

/* prettier-ignore */
@theme {
  --axo-color-surface-primary:          light-dark(#fafafa, #191919);
  --axo-color-surface-secondary:        light-dark(#f5f5f5, #1e1e1e);
  --axo-color-surface-tertiary:         light-dark(#f0f0f0, #282828);
  --axo-color-surface-quaternary:       light-dark(#e6e6e6, #373737);
  --axo-color-surface-card:             light-dark(#ffffff, --alpha(#969696 / 8%));
  --axo-color-surface-message-incoming: light-dark(#ebebeb, #323232);
  --axo-color-surface-message-outgoing: light-dark(#2267f5, #2267f5);
}

/* prettier-ignore */
@layer theme {
  @media (prefers-contrast: more) {
    :root {
      --axo-color-surface-primary:          light-dark(#fafafa, #191919);
      --axo-color-surface-secondary:        light-dark(#f5f5f5, #1e1e1e);
      --axo-color-surface-tertiary:         light-dark(#f0f0f0, #282828);
      --axo-color-surface-quaternary:       light-dark(#e6e6e6, #373737);
      --axo-color-surface-card:             light-dark(#ffffff, --alpha(#969696 / 8%));
      --axo-color-surface-message-incoming: light-dark(#e1e1e1, #3c3c3c);
      --axo-color-surface-message-outgoing: light-dark(#0842b9, #0842b9);
    }
  }
}

/**
 * Materials
 * --------------------------------------------------------------------------
 * Color with background blur and effects, usually backgrounds and containers
 */

@utility bg-material-* {
  background-color: --value(--axo-color-material-*);
}

/* prettier-ignore */
@theme {
  --axo-color-material-primary:            light-dark(--alpha(#fafafa / 90%), --alpha(#191919 / 90%));
  --axo-color-material-secondary:          light-dark(--alpha(#f4f4f4 / 90%), --alpha(#1f1f1f / 90%));
  --axo-color-material-tertiary:           light-dark(--alpha(#efefef / 90%), --alpha(#2a2a2a / 90%));
  --axo-color-material-tertiary-pressed:   light-dark(--alpha(#e9e9e9 / 90%), --alpha(#2f2f2f / 90%));
  --axo-color-material-quaternary:         light-dark(--alpha(#e4e4e4 / 90%), --alpha(#353535 / 90%));
  --axo-color-material-quaternary-pressed: light-dark(--alpha(#dedede / 90%), --alpha(#3a3a3a / 90%));
  --axo-color-material-dim-primary:        light-dark(--alpha(#383838 / 90%), --alpha(#515151 / 90%));
  --axo-color-material-dim-secondary:      light-dark(--alpha(#646464 / 90%), --alpha(#454545 / 90%));
  --axo-color-material-dialog:             light-dark(--alpha(#fafafa / 90%), --alpha(#353535 / 90%));
  --axo-color-material-warning:            light-dark(--alpha(#fff7d6 / 80%), --alpha(#49442f / 80%));
}

/* prettier-ignore */
@layer theme {
  @media (prefers-contrast: more) or (prefers-reduced-transparency: reduce) {
    :root {
      --axo-color-material-primary:            light-dark(#fafafa, #191919);
      --axo-color-material-secondary:          light-dark(#f5f5f5, #1e1e1e);
      --axo-color-material-tertiary:           light-dark(#f0f0f0, #282828);
      --axo-color-material-tertiary-pressed:   light-dark(#ebebeb, #2d2d2d);
      --axo-color-material-quaternary:         light-dark(#e6e6e6, #323232);
      --axo-color-material-quaternary-pressed: light-dark(#e1e1e1, #373737);
      --axo-color-material-dim-primary:        light-dark(#4b4b4b, #4b4b4b);
      --axo-color-material-dim-secondary:      light-dark(#737373, #414141);
      --axo-color-material-dialog:             light-dark(#fafafa, #323232);
      --axo-color-material-warning:            light-dark(#fff9e0, #443f2c);
    }
  }
}

/**
 * Fills
 * --------------------------------------------------------------------------
 * Usually semi-transparent, used for buttons and other primatives, has
 * pressed states.
 */

@utility bg-* {
  background-color: --value(--axo-color-fill-*);
}

@utility fill-* {
  fill: --value(--axo-color-fill-*);
}

/* prettier-ignore */
@theme {
  --axo-color-fill-primary:           light-dark(--alpha(#7d7d7d / 8%), --alpha(#969696 / 12%));
  --axo-color-fill-primary-pressed:   light-dark(--alpha(#7d7d7d / 12%), --alpha(#969696 / 16%));
  --axo-color-fill-secondary:         light-dark(--alpha(#7d7d7d / 16%), --alpha(#969696 / 20%));
  --axo-color-fill-secondary-pressed: light-dark(--alpha(#7d7d7d / 20%), --alpha(#969696 / 24%));
  --axo-color-fill-tertiary:          light-dark(--alpha(#7d7d7d / 24%), --alpha(#969696 / 28%));
  --axo-color-fill-tertiary-pressed:  light-dark(--alpha(#7d7d7d / 28%), --alpha(#969696 / 32%));
  --axo-color-fill-control:           light-dark(#ffffff, --alpha(#969696 / 12%));
  --axo-color-fill-control-pressed:   light-dark(#fafafa, --alpha(#969696 / 16%));
  --axo-color-fill-inverted:          light-dark(#414141, #dcdcdc);
  --axo-color-fill-inverted-pressed:  light-dark(#4b4b4b, #d2d2d2);
  --axo-color-fill-overlay:           light-dark(--alpha(#000000 / 24%), --alpha(#000000 / 48%));
}

/* prettier-ignore */
@layer theme {
  @media (prefers-contrast: more) {
    :root {
      --axo-color-fill-primary:           light-dark(--alpha(#7d7d7d / 16%), --alpha(#969696 / 20%));
      --axo-color-fill-primary-pressed:   light-dark(--alpha(#7d7d7d / 20%), --alpha(#969696 / 24%));
      --axo-color-fill-secondary:         light-dark(--alpha(#7d7d7d / 24%), --alpha(#969696 / 28%));
      --axo-color-fill-secondary-pressed: light-dark(--alpha(#7d7d7d / 28%), --alpha(#969696 / 32%));
      --axo-color-fill-tertiary:          light-dark(--alpha(#7d7d7d / 32%), --alpha(#969696 / 36%));
      --axo-color-fill-tertiary-pressed:  light-dark(--alpha(#7d7d7d / 36%), --alpha(#969696 / 40%));
      --axo-color-fill-control:           light-dark(--alpha(#969696 / 20%));
      --axo-color-fill-control-pressed:   light-dark(#fafafa, --alpha(#969696 / 24%));
      --axo-color-fill-inverted:          light-dark(#232323, #ebebeb);
      --axo-color-fill-inverted-pressed:  light-dark(#2d2d2d, #e1e1e1);
      --axo-color-fill-overlay:           light-dark(--alpha(#000000 / 48%), --alpha(#000000 / 64%));
    }
  }
}

/**
 * Fills (On Message)
 * ----------------------------------------------------------------------------
 */

/* prettier-ignore */
@theme {
  --axo-color-fill-onmessage-incoming-primary:           light-dark(--alpha(#fefefe / 80%), --alpha(#e6e6e6 / 16%));
  --axo-color-fill-onmessage-incoming-primary-pressed:   light-dark(--alpha(#fefefe / 60%), --alpha(#e6e6e6 / 20%));
  --axo-color-fill-onmessage-incoming-secondary:         light-dark(--alpha(#fefefe / 60%), --alpha(#e6e6e6 / 12%));
  --axo-color-fill-onmessage-incoming-secondary-pressed: light-dark(--alpha(#fefefe / 36%), --alpha(#e6e6e6 / 16%));
  --axo-color-fill-onmessage-outgoing-primary:           light-dark(--alpha(#ffffff / 20%), --alpha(#ffffff / 20%));
  --axo-color-fill-onmessage-outgoing-primary-pressed:   light-dark(--alpha(#ffffff / 16%), --alpha(#ffffff / 24%));
  --axo-color-fill-onmessage-outgoing-secondary:         light-dark(--alpha(#ffffff / 60%), --alpha(#ffffff / 52%));
  --axo-color-fill-onmessage-outgoing-secondary-pressed: light-dark(--alpha(#ffffff / 56%), --alpha(#ffffff / 56%));
}

/* prettier-ignore */
@layer theme {
  @media (prefers-contrast: more) {
    :root {
      --axo-color-fill-onmessage-incoming-primary:           light-dark(--alpha(#fefefe / 80%), --alpha(#e6e6e6 / 16%));
      --axo-color-fill-onmessage-incoming-primary-pressed:   light-dark(--alpha(#fefefe / 60%), --alpha(#e6e6e6 / 20%));
      --axo-color-fill-onmessage-incoming-secondary:         light-dark(--alpha(#fefefe / 64%), --alpha(#e6e6e6 / 12%));
      --axo-color-fill-onmessage-incoming-secondary-pressed: light-dark(--alpha(#fefefe / 52%), --alpha(#e6e6e6 / 16%));
      --axo-color-fill-onmessage-outgoing-primary:           light-dark(--alpha(#ffffff / 20%), --alpha(#ffffff / 20%));
      --axo-color-fill-onmessage-outgoing-primary-pressed:   light-dark(--alpha(#ffffff / 16%), --alpha(#ffffff / 24%));
      --axo-color-fill-onmessage-outgoing-secondary:         light-dark(--alpha(#ffffff / 68%), --alpha(#ffffff / 64%));
      --axo-color-fill-onmessage-outgoing-secondary-pressed: light-dark(--alpha(#ffffff / 64%), --alpha(#ffffff / 68%));
    }
  }
}

/**
 * Fills (Colors)
 * --------------------------------------------------------------------------
 */

/* prettier-ignore */
@theme {
  --axo-color-fill-accent:                     light-dark(#4655ff, #5563ff);
  --axo-color-fill-accent-pressed:             light-dark(#3b4af4, #616eff);
  --axo-color-fill-accent-bright:              light-dark(#b2b9ff, #b2b9ff);
  --axo-color-fill-accent-bright-pressed:      light-dark(#a8b0ff, #a8b0ff);
  --axo-color-fill-accent-tint:                light-dark(--alpha(#030ffc / 6%), --alpha(#99a1ff / 12%));
  --axo-color-fill-accent-tint-pressed:        light-dark(--alpha(#030ffc / 10%), --alpha(#99a1ff / 16%));

  --axo-color-fill-affirmative:                light-dark(#09a523, #07ab23);
  --axo-color-fill-affirmative-pressed:        light-dark(#089b21, #08b525);
  --axo-color-fill-affirmative-bright:         light-dark(#6ce280, #6ce280);
  --axo-color-fill-affirmative-bright-pressed: light-dark(#55dd6b, #55dd6b);
  --axo-color-fill-affirmative-tint:           light-dark(--alpha(#00a015 / 8%), --alpha(#30d150 / 12%));
  --axo-color-fill-affirmative-tint-pressed:   light-dark(--alpha(#00a015 / 12%), --alpha(#30d150 / 16%));

  --axo-color-fill-warning-bright:             light-dark(#f9dd6c, #f9dd6c);
  --axo-color-fill-warning-bright-pressed:     light-dark(#f5d761, #f5d761);
  --axo-color-fill-warning-tint:               light-dark(--alpha(#f5c400 / 20%), --alpha(#ffde5b / 12%));
  --axo-color-fill-warning-tint-pressed:       light-dark(--alpha(#f5c400 / 24%), --alpha(#ffde5b / 16%));

  --axo-color-fill-safety:                     light-dark(#d35e3b, #b14f32);
  --axo-color-fill-safety-pressed:             light-dark(#bc5a2a, #bf5536);
  --axo-color-fill-safety-tint:                light-dark(--alpha(#b95929 / 12%), --alpha(#eb977d / 16%));
  --axo-color-fill-safety-tint-pressed:        light-dark(--alpha(#b95929 / 16%), --alpha(#eb977d / 20%));

  --axo-color-fill-destructive:                light-dark(#f21c0d, #ee382c);
  --axo-color-fill-destructive-pressed:        light-dark(#e41a0c, #ef493e);
  --axo-color-fill-destructive-tint:           light-dark(--alpha(#f21602 / 6%), --alpha(#ff4a3a / 12%));
  --axo-color-fill-destructive-tint-pressed:   light-dark(--alpha(#f21602 / 10%), --alpha(#ff4a3a / 16%));

  --axo-color-fill-white:                      light-dark(#ffffff, #ffffff);
  --axo-color-fill-white-pressed:              light-dark(#fafafa, #fafafa);
}

/* prettier-ignore */
@layer theme {
  @media (prefers-contrast: more) {
    :root {
      --axo-color-fill-accent:                     light-dark(#1f31ff, #2536f9);
      --axo-color-fill-accent-pressed:             light-dark(#0519ff, #2e3ffa);
      --axo-color-fill-accent-bright:              light-dark(#b2b9ff, #b2b9ff);
      --axo-color-fill-accent-bright-pressed:      light-dark(#a8b0ff, #a8b0ff);
      --axo-color-fill-accent-tint:                light-dark(--alpha(#030ffc / 10%), --alpha(#99a1ff / 18%));
      --axo-color-fill-accent-tint-pressed:        light-dark(--alpha(#030ffc / 14%), --alpha(#99a1ff / 22%));

      --axo-color-fill-affirmative:                light-dark(#007514, #007514);
      --axo-color-fill-affirmative-pressed:        light-dark(#006b12, #008016);
      --axo-color-fill-affirmative-bright:         light-dark(#6ce280, #6ce280);
      --axo-color-fill-affirmative-bright-pressed: light-dark(#55dd6b, #55dd6b);
      --axo-color-fill-affirmative-tint:           light-dark(--alpha(#00a015 / 12%), --alpha(#30d150 / 20%));
      --axo-color-fill-affirmative-tint-pressed:   light-dark(--alpha(#00a015 / 16%), --alpha(#30d150 / 24%));

      --axo-color-fill-warning-bright:             light-dark(#f9dd6c, #f9dd6c);
      --axo-color-fill-warning-bright-pressed:     light-dark(#f5d761, #f5d761);
      --axo-color-fill-warning-tint:               light-dark(--alpha(#f5c400 / 20%), --alpha(#ffde5b / 16%));
      --axo-color-fill-warning-tint-pressed:       light-dark(--alpha(#f5c400 / 24%), --alpha(#ffde5b / 20%));

      --axo-color-fill-safety:                     light-dark(#993f24, #993f24);
      --axo-color-fill-safety-pressed:             light-dark(#8c3a21, #a14226);
      --axo-color-fill-safety-tint:                light-dark(--alpha(#b95929 / 12%), --alpha(#eb977d / 16%));
      --axo-color-fill-safety-tint-pressed:        light-dark(--alpha(#b95929 / 16%), --alpha(#eb977d / 20%));

      --axo-color-fill-destructive:                light-dark(#b80c00, #b80c00);
      --axo-color-fill-destructive-pressed:        light-dark(#a80b00, #c20d00);
      --axo-color-fill-destructive-tint:           light-dark(--alpha(#d91304 / 12%), --alpha(#ff4a3a / 20%));
      --axo-color-fill-destructive-tint-pressed:   light-dark(--alpha(#d91304 / 16%), --alpha(#ff4a3a / 24%));

      --axo-color-fill-white:                      light-dark(#ffffff, #ffffff);
      --axo-color-fill-white-pressed:              light-dark(#fafafa, #fafafa);
    }
  }
}

/**
 * Borders
 * --------------------------------------------------------------------------
 */

@utility border-* {
  border-color: --value(--axo-color-border-*);
}

@utility border-t-* {
  border-top-color: --value(--axo-color-border-*);
}
@utility border-b-* {
  border-bottom-color: --value(--axo-color-border-*);
}
@utility border-l-* {
  border-left-color: --value(--axo-color-border-*);
}
@utility border-r-* {
  border-right-color: --value(--axo-color-border-*);
}

@utility border-x-* {
  border-inline-color: --value(--axo-color-border-*);
}
@utility border-y-* {
  border-block-color: --value(--axo-color-border-*);
}

@utility border-s-* {
  border-inline-start-color: --value(--axo-color-border-*);
}
@utility border-e-* {
  border-inline-end-color: --value(--axo-color-border-*);
}

@utility border-bs-* {
  border-block-start-color: --value(--axo-color-border-*);
}
@utility border-be-* {
  border-block-end-color: --value(--axo-color-border-*);
}

@utility stroke-* {
  stroke: --value(--axo-color-border-*);
}

@utility outline-* {
  outline-color: --value(--axo-color-border-*);
}

/* prettier-ignore */
@theme {
  --axo-color-border-primary:               light-dark(--alpha(#000000 / 6%), --alpha(#ffffff / 6%));
  --axo-color-border-secondary:             light-dark(--alpha(#000000 / 12%), --alpha(#ffffff / 12%));
  --axo-color-border-tertiary:              light-dark(--alpha(#000000 / 24%), --alpha(#ffffff / 24%));
  --axo-color-border-selected:              light-dark(#4655ff, #c9ceff);
  --axo-color-border-selected-oncolor:      light-dark(#fafafa, #fafafa);
  --axo-color-border-focused-inner:         light-dark(#ffffff, #000000);
  --axo-color-border-focused-outer:         light-dark(#808190, #c9cbda);
  --axo-color-border-focused-inner-oncolor: light-dark(#000000, #000000);
  --axo-color-border-focused-outer-oncolor: light-dark(#f4f5fe, #f4f5fe);
}

/* prettier-ignore */
@layer theme {
  @media (prefers-contrast: more) {
    :root {
      --axo-color-border-primary:               light-dark(--alpha(#000000 / 24%), --alpha(#ffffff / 24%));
      --axo-color-border-secondary:             light-dark(--alpha(#000000 / 32%), --alpha(#ffffff / 32%));
      --axo-color-border-tertiary:              light-dark(--alpha(#000000 / 70%), --alpha(#ffffff / 70%));
      --axo-color-border-selected:              light-dark(#3243ff, #c9ceff);
      --axo-color-border-selected-oncolor:      light-dark(#fafafa, #fafafa);
      --axo-color-border-focused-inner:         light-dark(#ffffff, #000000);
      --axo-color-border-focused-outer:         light-dark(#67697e, #e4e5f0);
      --axo-color-border-focused-inner-oncolor: light-dark(#000000, #000000);
      --axo-color-border-focused-outer-oncolor: light-dark(#ffffff, #ffffff);
    }
  }
}

/**
 * Deprecated Axo Colors
 * ----------------------------------------------------------------------------
 */

/* prettier-ignore */
@theme {
  --axo-color-deprecated-border-error:  light-dark(#fd2512, #fb4332);
  --axo-color-deprecated-fill-on-media: light-dark(--alpha(#000000 / 75%), --alpha(#000000 / 75%));
}

/* prettier-ignore */
@layer theme {
  @media (prefers-contrast: more) {
    :root {
      --axo-color-deprecated-border-error:  light-dark(#b7271a, #fb4332);
      --axo-color-deprecated-fill-on-media: light-dark(--alpha(#000000 / 85%), --alpha(#000000 / 85%));
    }
  }
}

/**
 * Legacy Colors
 * ----------------------------------------------------------------------------
 * These should all eventually be removed, but in places where we need new
 * components to specifically match the colors of older components, we can
 * add them here.
 */

/* prettier-ignore */
@theme {
  --axo-color-legacy-conversation-header-bg:   light-dark(#fff, #121212);
  --axo-color-legacy-signal-conversation-bg:   light-dark(#F6F7FF, #2F3240);
  --axo-color-legacy-official-chat-badge-bg:   light-dark(--alpha(#4655FF / 12%), --alpha(#4952F8 / 40%));
  --axo-color-legacy-official-chat-badge-text: light-dark(#030FFC, #C2C5FE);
  --axo-color-legacy-signal-chat-message-bg:   light-dark(#8889B4, #444664);
  --axo-color-legacy-warning-badge:            light-dark(#C84118, #EB977D);
}


```

## Raw Axo fonts

```css
/**
 * Copyright 2025 Signal Messenger, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Type Util
 * ----------------------------------------------------------------------------
 * Prefer using `type-*` over individual properties
 */

/* prettier-ignore */
@utility type-* {
  font-family:    --value(--font-sans);
  font-size:      --value(--axo-text-*);
  font-weight:    --value(--axo-font-weight-*);
  letter-spacing: --value(--axo-tracking-*);
  line-height:    --value(--axo-leading-*);
}

/**
 * Font Family
 * ----------------------------------------------------------------------------
 */

/* prettier-ignore */
@theme {
  --font-*: initial; /* reset defaults */
  /* Note: --font-sans also has language */
  --font-sans:
    Inter,
    'Source Sans Pro',
    'Source Han Sans',
    'Signal Emoji Large',
    'Signal Emoji Small',
    -apple-system,
    system-ui,
    'Segoe UI',
    'Noto Sans',
    'Helvetica Neue',
    Helvetica,
    Arial,
    sans-serif;
  /* Note: This font-family is checked for in matchMonospace, to support paste scenarios */
  --font-mono:
    'SF Mono',
    SFMono-Regular,
    ui-monospace,
    'DejaVu Sans Mono',
    Menlo,
    Consolas,
    monospace;
  --font-symbols: 'SignalSymbols';
}

/* prettier-ignore */
@layer theme {
  /* Japanese */
  :lang(ja) {
    --font-sans:
      Inter,
       'SF Pro',
       'SF Pro JP',
       'BIZ UDGothic',
       'Hiragino Kaku Gothic Pro',
      'Ä‡Āā€™Ä‡ĀĀ©Ä‡ā€Ā®Ä‡ĀĖ‡Ä¨Ā§ā€™Ä‡ā€Ā´ Pro W3',
       Ä‡Āļ£¼Ä‡ā€Ā¤Ä‡ĀÅ–Ä‡ā€Å–,
       Meiryo,
       'Ä¼Ā¼Ā­Ä¼Ā¼Ā³ Ä¼Ā¼Ā°Ä‡ā€Ā´Ä‡ā€Ā·Ä‡ĀĀÄ‡ā€Ć†',
      'Signal Emoji Large',
       'Signal Emoji Small',
       'Helvetica Neue',
       Helvetica,
      Arial,
      sans-serif;
  }
  /* Farsi (Persian) */
  :lang(fa) {
    --font-sans:
      'Vazirmatn',
      Inter,
      'Noto Sans Arabic',
      'Signal Emoji Large',
      'Signal Emoji Small',
      -apple-system,
      system-ui,
      BlinkMacSystemFont,
      'Segoe UI',
      Tahoma,
      Helvetica,
      Arial,
      sans-serif;
  }
  /* Urdu */
  :lang(ur) {
    --font-sans:
      'Noto Nastaliq Urdu',
      Gulzar,
      'Jameel Noori Nastaleeq',
      'Faiz Lahori Nastaleeq',
      'Urdu Typesetting',
      Helvetica,
      Arial,
      'Signal Emoji Large',
      'Signal Emoji Small',
      sans-serif;
  }
}

/**
 * Font Sizes
 * ----------------------------------------------------------------------------
 */

/* prettier-ignore */
@theme {
  /* text-size */
  --text-*: initial; /* reset defaults */

  /* (no defaults, use presets) */

  /* Presets */
  --axo-text-title-large:  1.5rem    /* 24px */;
  --axo-text-title-medium: 1.125rem  /* 18px */;
  --axo-text-title-small:  0.875rem  /* 14px */;
  --axo-text-body-large:   0.875rem  /* 14px */;
  --axo-text-body-medium:  0.8125rem /* 13px */;
  --axo-text-body-small:   0.75rem   /* 12px */;
  --axo-text-caption:      0.6875rem /* 11px */;
}

/**
 * Font Weights
 * ----------------------------------------------------------------------------
 */

/* prettier-ignore */
@theme {
  /* font-weight */
  --font-weight-*: initial; /* reset defaults */

  /* Defaults */
  --font-weight-semibold: 600;
  --font-weight-medium:   500;
  --font-weight-regular:  400;
  --font-weight-light:    300;

  /* Presets */
  --axo-font-weight-title-large:  var(--font-weight-semibold);
  --axo-font-weight-title-medium: var(--font-weight-semibold);
  --axo-font-weight-title-small:  var(--font-weight-semibold);
  --axo-font-weight-body-large:   var(--font-weight-regular);
  --axo-font-weight-body-medium:  var(--font-weight-regular);
  --axo-font-weight-body-small:   var(--font-weight-regular);
  --axo-font-weight-caption:      var(--font-weight-regular);
}

/**
 * Letter Spacing
 * ----------------------------------------------------------------------------
 */

/* prettier-ignore */
@theme {
  /* letter-spacing */
  --tracking-*: initial; /* reset defaults */

  /* (no defaults, use presets) */

  /* Presets */
  --axo-tracking-title-large:  -0.019em /* (@ 24px) -0.46px */;
  --axo-tracking-title-medium: -0.014em /* (@ 18px) -0.25px */;
  --axo-tracking-title-small:  -0.006em /* (@ 14px) -0.08px */;
  --axo-tracking-body-large:   -0.006em /* (@ 14px) -0.08px */;
  --axo-tracking-body-medium:  -0.003em /* (@ 13px) -0.04px */;
  --axo-tracking-body-small:    0em     /* (@ 12px)  0px    */;
  --axo-tracking-caption:       0.005em /* (@ 11px)  0.05px */;
}

/**
 * Line Height
 * ----------------------------------------------------------------------------
 */

/* prettier-ignore */
@theme {
  /* line-height */
  --leading-*: initial; /* reset defaults */
  --leading-none: 1; /* useful as reset */

  /* (no defaults, use presets) */

  /* Presets */
  --axo-leading-title-large:  2rem     /* 32px */;
  --axo-leading-title-medium: 1.5rem   /* 24px */;
  --axo-leading-title-small:  1.25rem  /* 20px */;
  --axo-leading-body-large:   1.25rem  /* 20px */;
  --axo-leading-body-medium:  1.125rem /* 18px */;
  --axo-leading-body-small:   1rem     /* 16px */;
  --axo-leading-caption:      0.875rem /* 14px */;
}


```

## Raw Axo shadows

```css
/**
 * Copyright 2026 Signal Messenger, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Colors
 * ----------------------------------------------------------------------------
 */

/* prettier-ignore */
@theme {
  --axo-shadow-color-elevation-1: light-dark(--alpha(#000 / 08%), --alpha(#000 / 16%));
  --axo-shadow-color-elevation-2: light-dark(--alpha(#000 / 08%), --alpha(#000 / 16%));
  --axo-shadow-color-elevation-3: light-dark(--alpha(#000 / 10%), --alpha(#000 / 20%));
  --axo-shadow-color-elevation-4: light-dark(--alpha(#000 / 12%), --alpha(#000 / 24%));
  --axo-shadow-color-elevation-5: light-dark(--alpha(#000 / 20%), --alpha(#000 / 40%));
  --axo-shadow-color-outline:     light-dark(--alpha(#000 / 12%), transparent);
  --axo-shadow-color-highlight:   light-dark(transparent, --alpha(#fff / 08%));
}

/* prettier-ignore */
@layer theme {
  @media (prefers-contrast: more) {
    :root {
      --axo-shadow-color-outline:   light-dark(--alpha(#000 / 32%), transparent);
      --axo-shadow-color-highlight: light-dark(transparent, --alpha(#fff / 32%));
    }
  }
}

/**
 * Presets
 * ----------------------------------------------------------------------------
 */

/* prettier-ignore */
@theme {
  /* shared shadow styles */

  --base-shadow-outline:
    inset 0 0 0 0.5px var(--axo-shadow-color-highlight),
    0 0 0 0.5px var(--axo-shadow-color-outline);
  --base-shadow-elevation-0: 0  1px  2px 0 var(--axo-shadow-color-elevation-1);
  --base-shadow-elevation-1: 0  2px  8px 0 var(--axo-shadow-color-elevation-2);
  --base-shadow-elevation-2: 0  4px 12px 0 var(--axo-shadow-color-elevation-3);
  --base-shadow-elevation-3: 0  6px 16px 0 var(--axo-shadow-color-elevation-4);
  --base-shadow-elevation-4: 0 12px 56px 0 var(--axo-shadow-color-elevation-5);

  /* box-shadow */
  --shadow-*: initial; /* reset defaults */
  /* Note: Use 'shadow-no-outline' to remove the outline/highlight shadows */
  --shadow-elevation-0: var(--axo-shadow-no-outline, var(--base-shadow-outline)), var(--base-shadow-elevation-0);
  --shadow-elevation-1: var(--axo-shadow-no-outline, var(--base-shadow-outline)), var(--base-shadow-elevation-1);
  --shadow-elevation-2: var(--axo-shadow-no-outline, var(--base-shadow-outline)), var(--base-shadow-elevation-2);
  --shadow-elevation-3: var(--axo-shadow-no-outline, var(--base-shadow-outline)), var(--base-shadow-elevation-3);
  --shadow-elevation-4: var(--axo-shadow-no-outline, var(--base-shadow-outline)), var(--base-shadow-elevation-4);

  /* box-shadow: inset */
  --inset-shadow-*: initial; /* reset defaults */
  --inset-shadow-on-color:
    inset 0 0.5px 1px 0 --alpha(#000 / 12%);

  /* filter: drop-shadow() */
  --drop-shadow-*: initial; /* reset defaults */
  /* Note: Use 'drop-shadow-no-outline' to remove the outline/highlight shadows */
  --drop-shadow-elevation-0: var(--axo-drop-shadow-no-outline, var(--base-shadow-outline)), var(--shadow-elevation-0);
  --drop-shadow-elevation-1: var(--axo-drop-shadow-no-outline, var(--base-shadow-outline)), var(--shadow-elevation-1);
  --drop-shadow-elevation-2: var(--axo-drop-shadow-no-outline, var(--base-shadow-outline)), var(--shadow-elevation-2);
  --drop-shadow-elevation-3: var(--axo-drop-shadow-no-outline, var(--base-shadow-outline)), var(--shadow-elevation-3);
  --drop-shadow-elevation-4: var(--axo-drop-shadow-no-outline, var(--base-shadow-outline)), var(--shadow-elevation-4);
}

/**
 * Utils
 * ----------------------------------------------------------------------------
 */

@property --axo-shadow-no-outline {
  syntax: '*';
  inherits: false;
}
@property --axo-drop-shadow-no-outline {
  syntax: '*';
  inherits: false;
}

@utility shadow-no-outline {
  --axo-shadow-no-outline: 0 0 #0000; /* invisible shadow */
}

@utility drop-shadow-no-outline {
  --axo-drop-shadow-outline: 0 0 #0000; /* invisible shadow */
}


```

## Raw shared SCSS variables

```scss
// Copyright 2015 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Note: Add language-specific fallbacks in @localized-fonts mixin
$inter:
  Inter,
  'Source Sans Pro',
  'Source Han Sans',
  'Signal Emoji Large',
  'Signal Emoji Small',
  -apple-system,
  system-ui,
  'Segoe UI',
  'Noto Sans',
  'Helvetica Neue',
  Helvetica,
  Arial,
  sans-serif;

// Note: This font-family is checked for in matchMonospace, to support paste scenarios
$monospace:
  'SF Mono', SFMono-Regular, ui-monospace, 'DejaVu Sans Mono', Menlo, Consolas,
  monospace;

// -- V3 Colors

$color-accent-blue: #2c6bed;
$color-accent-green: #4caf50;
$color-accent-red: #f44336;
$color-accent-yellow: #ffd624;

$color-white: #ffffff;
$color-gray-02: #f6f6f6;
$color-gray-04: #f0f0f0;
$color-gray-05: #e9e9e9;
$color-gray-15: #dedede;
$color-gray-20: #c6c6c6;
$color-gray-25: #b9b9b9;
$color-gray-40: #808080;
$color-gray-45: #848484;
$color-gray-60: #5e5e5e;
$color-gray-62: #545454;
$color-gray-65: #4a4a4a;
$color-gray-75: #3b3b3b;
$color-gray-78: #343434;
$color-gray-80: #2e2e2e;
$color-gray-85: #262626;
$color-gray-90: #1b1b1b;
$color-gray-95: #121212;
$color-black: #000000;

$color-white-alpha-06: rgba($color-white, 0.06);
$color-white-alpha-08: rgba($color-white, 0.08);
$color-white-alpha-10: rgba($color-white, 0.1);
$color-white-alpha-12: rgba($color-white, 0.12);
$color-white-alpha-16: rgba($color-white, 0.16);
$color-white-alpha-20: rgba($color-white, 0.2);
$color-white-alpha-30: rgba($color-white, 0.3);
$color-white-alpha-36: rgba($color-white, 0.36);
$color-white-alpha-40: rgba($color-white, 0.4);
$color-white-alpha-50: rgba($color-white, 0.5);
$color-white-alpha-55: rgba($color-white, 0.55);
$color-white-alpha-60: rgba($color-white, 0.6);
$color-white-alpha-70: rgba($color-white, 0.7);
$color-white-alpha-80: rgba($color-white, 0.8);
$color-white-alpha-85: rgba($color-white, 0.85);
$color-white-alpha-90: rgba($color-white, 0.9);

$color-black-alpha-05: rgba($color-black, 0.05);
$color-black-alpha-06: rgba($color-black, 0.06);
$color-black-alpha-08: rgba($color-black, 0.08);
// Equivalent to gray-05 on a white background
$color-black-alpha-085: rgba($color-black, 0.085);
$color-black-alpha-10: rgba($color-black, 0.1);
$color-black-alpha-12: rgba($color-black, 0.12);
$color-black-alpha-16: rgba($color-black, 0.16);
$color-black-alpha-20: rgba($color-black, 0.2);
$color-black-alpha-24: rgba($color-black, 0.24);
$color-black-alpha-30: rgba($color-black, 0.3);
$color-black-alpha-40: rgba($color-black, 0.4);
$color-black-alpha-50: rgba($color-black, 0.5);
$color-black-alpha-60: rgba($color-black, 0.6);
$color-black-alpha-70: rgba($color-black, 0.7);
$color-black-alpha-80: rgba($color-black, 0.8);
$color-black-alpha-85: rgba($color-black, 0.85);
$color-black-alpha-90: rgba($color-black, 0.9);

$color-transparent: rgba(0, 0, 0, 0);

$color-ultramarine-dark: #1851b4;
$color-ultramarine-logo: #3b45fd;
$color-ultramarine-light: #6191f3;
$color-ultramarine-dawn: #406ec9;
$color-ultramarine-pastel: #abc4f8;
$color-ultramarine-pale: #d2dffb;
$color-ultramarine: #2c6bed;
$color-link: #315ff4;

// Flat colors

$color-crimson: #cf163e;
$color-vermilion: #c73f0a;
$color-burlap: #6f6a58;
$color-forest: #3b7845;
$color-wintergreen: #1d8663;
$color-teal: #077d92;
$color-blue: #336ba3;
$color-indigo: #6058ca;
$color-violet: #9932c8;
$color-plum: #aa377a;
$color-taupe: #8f616a;
$color-steel: #71717f;
$color-bright-gray: #ebeae8;
$color-borage-blue: #506ecd;
$color-orange: #ff9500;

// Gradient colors

$color-ultramarine-gradient: (
  deg: 180deg,
  start: #0552f0,
  end: $color-ultramarine,
);
$color-basil: (
  deg: 180deg,
  start: #2f9373,
  end: #077343,
);
$color-ember: (
  deg: 168deg,
  start: #e57c00,
  end: #5e0000,
);
$color-fluorescent: (
  deg: 192deg,
  start: #ec13dd,
  end: #1b36c6,
);
$color-infrared: (
  deg: 192deg,
  start: #f65560,
  end: #442ced,
);
$color-lagoon: (
  deg: 180deg,
  start: #004066,
  end: #32867d,
);
$color-midnight: (
  deg: 180deg,
  start: #2c2c3a,
  end: #787891,
);
$color-sea: (
  deg: 180deg,
  start: #498fd4,
  end: #2c66a0,
);
$color-sublime: (
  deg: 180deg,
  start: #6281d5,
  end: #974460,
);
$color-tangerine: (
  deg: 192deg,
  start: #db7133,
  end: #911231,
);

// Avatars

$avatar-color-A100: (
  bg: #e3e3fe,
  fg: #3838f5,
);
$avatar-color-A110: (
  bg: #dde7fc,
  fg: #1251d3,
);
$avatar-color-A120: (
  bg: #d8e8f0,
  fg: #086da0,
);
$avatar-color-A130: (
  bg: #cde4cd,
  fg: #067906,
);
$avatar-color-A140: (
  bg: #eae0fd,
  fg: #661aff,
);
$avatar-color-A150: (
  bg: #f5e3fe,
  fg: #9f00f0,
);
$avatar-color-A160: (
  bg: #f6d8ec,
  fg: #b8057c,
);
$avatar-color-A170: (
  bg: #f5d7d7,
  fg: #be0404,
);
$avatar-color-A180: (
  bg: #fef5d0,
  fg: #836b01,
);
$avatar-color-A190: (
  bg: #eae6d5,
  fg: #7d6f40,
);
$avatar-color-A200: (
  bg: #d2d2dc,
  fg: #4f4f6d,
);
$avatar-color-A210: (
  bg: #d7d7d9,
  fg: #5c5c5c,
);

// Maps for easy manipulation

$avatar-colors: (
  A100: $avatar-color-A100,
  A110: $avatar-color-A110,
  A120: $avatar-color-A120,
  A130: $avatar-color-A130,
  A140: $avatar-color-A140,
  A150: $avatar-color-A150,
  A160: $avatar-color-A160,
  A170: $avatar-color-A170,
  A180: $avatar-color-A180,
  A190: $avatar-color-A190,
  A200: $avatar-color-A200,
  A210: $avatar-color-A210,
);

$conversation-colors: (
  'blue': $color-blue,
  'burlap': $color-burlap,
  'crimson': $color-crimson,
  'forest': $color-forest,
  'indigo': $color-indigo,
  'plum': $color-plum,
  'steel': $color-steel,
  'taupe': $color-taupe,
  'teal': $color-teal,
  'vermilion': $color-vermilion,
  'violet': $color-violet,
  'wintergreen': $color-wintergreen,
);

$conversation-colors-gradient: (
  'ultramarine': $color-ultramarine-gradient,
  'basil': $color-basil,
  'ember': $color-ember,
  'fluorescent': $color-fluorescent,
  'infrared': $color-infrared,
  'lagoon': $color-lagoon,
  'midnight': $color-midnight,
  'sea': $color-sea,
  'sublime': $color-sublime,
  'tangerine': $color-tangerine,
);

// Used for safety number change warning banner, progress bars and toasts
$color-ios-blue-tint: #b0c8f9;

// -- Non-V3 colors

// Used in spinners
$color-white-alpha-40: rgba($color-white, 0.4);

// Used in tap-to-view error states
$color-deep-red: #ff261f;

$color-selected-message-background-light: rgba(44, 107, 237, 0.24);
$color-selected-message-background-dark: $color-gray-65;

$color-paypal-yellow: #f6c757;

$color-next-raised-hand: #6ce27c;

// -- A few layout variables used cross-file

$header-height: 52px;

$ease-out-expo: cubic-bezier(0.19, 1, 0.22, 1);
$ease-out-local-preview: cubic-bezier(0.17, 0.17, 0, 1);

$calling-background-color: $color-gray-90;

// Maintain aspect ratio 960x720 with $local-preview-height
$calling-local-preview-normal-width: 106.67px;

// General
// Keep in sync with --legacy-z-index-* in stylesheets/tailwind-config.css

$z-index-negative: -1;
$z-index-base: 1;
$z-index-above-base: 2;
$z-index-above-above-base: 3;
$z-index-megaphone: 75;
$z-index-popup-overlay: 99;
$z-index-popup: 100;
$z-index-context-menu: 125;
$z-index-tooltip: 150;
$z-index-toast: 200;
$z-index-on-top-of-everything: 9000;
$z-index-window-controls: 10000;

// Component specific
// The scroll down button should be above everything in the timeline but
// popups, tooltips, toasts, and other items should stack above it.
// Keep in sync with --legacy-z-index-* in stylesheets/tailwind-config.css
$z-index-story-meta: 3;
$z-index-scroll-down-button: 10;
$z-index-stories: 98;
$z-index-calling-container: 100;
$z-index-calling: 101;
$z-index-modal-host: 102;
$z-index-above-popup: 103;
$z-index-calling-pip: 104;
$z-index-above-context-menu: 126;

// global navTabs
$NavTabs__width: 80px;
// These values are 'block' specific to coordinate with the NavSidebar__Header
$NavTabs__Item__blockPadding: 2px;
$NavTabs__Toggle__blockPadding: 8px;
$NavTabs__ItemButton__blockPadding: 10px;
$CallControls__height: 80px;
$CallControls__max-width: 640px;
$CallControls__initial-width: 480px;

$scrollbar_height: 9px;
$scrollbar_width: 9px;


```



