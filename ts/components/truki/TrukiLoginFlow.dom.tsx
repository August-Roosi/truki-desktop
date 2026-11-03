// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

import { memo, useCallback, useId, useState } from 'react';
import type { FormEvent, JSX } from 'react';

import { AxoButton } from '../../axo/AxoButton.dom.tsx';
import { AxoPasswordField } from '../../axo/fields/AxoPasswordField.dom.tsx';
import { AxoTextField } from '../../axo/fields/AxoTextField.dom.tsx';
import { AxoLoadingIndicator } from '../../axo/status/AxoLoadingIndicator.dom.tsx';
import { tw } from '../../axo/tw.dom.tsx';
import type { LocalizerType } from '../../types/Util.std.ts';
import type {
  TrukiLoginInputField,
  TrukiLoginView,
} from '../../util/trukiLoginFlow.std.ts';
import {
  TRUKI_LOGIN_EXPIRED,
  TRUKI_LOGIN_UNSUPPORTED,
} from '../../util/trukiLoginFlow.std.ts';
import { QrCode } from '../QrCode.dom.tsx';

const MAX_GRAPHEMES = 256;
const MAX_BYTES = 1024;

export type TrukiLoginFlowProps = Readonly<{
  i18n: LocalizerType;
  networkName: string;
  view: TrukiLoginView;
  // A request for this login is in flight.
  busy: boolean;
  onChooseFlow: (flowId: string) => void;
  onSubmitInput: (input: Readonly<Record<string, string>>) => void;
  onOpenCookieLogin: () => void;
  onCancel: () => void;
  onRetry: () => void;
}>;

function Instructions({ text }: Readonly<{ text: string }>): JSX.Element {
  return (
    <p className={tw('m-0 type-body-medium whitespace-pre-line text-primary')}>
      {text}
    </p>
  );
}

function InputForm({
  i18n,
  fields,
  instructions,
  busy,
  onSubmit,
}: Readonly<{
  i18n: LocalizerType;
  fields: ReadonlyArray<TrukiLoginInputField>;
  instructions: string;
  busy: boolean;
  onSubmit: (input: Readonly<Record<string, string>>) => void;
}>): JSX.Element {
  const idPrefix = useId();
  const [values, setValues] = useState<Readonly<Record<string, string>>>(() =>
    Object.fromEntries(fields.map(f => [f.id, f.defaultValue]))
  );
  const missing = fields.some(f => !f.optional && !values[f.id]?.trim());

  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (!missing && !busy) {
        onSubmit(values);
      }
    },
    [busy, missing, onSubmit, values]
  );

  return (
    <form className={tw('flex flex-col gap-3')} onSubmit={handleSubmit}>
      {instructions && <Instructions text={instructions} />}
      {fields.map((field, index) => {
        const id = `${idPrefix}-${field.id}`;
        const value = values[field.id] ?? '';
        const setValue = (next: string) =>
          setValues(previous => ({ ...previous, [field.id]: next }));
        return (
          <div key={field.id} className={tw('flex flex-col gap-1')}>
            <label
              htmlFor={id}
              className={tw('type-body-medium font-semibold text-primary')}
            >
              {field.name}
            </label>
            {field.type === 'password' ? (
              <AxoPasswordField.Root
                value={value}
                onValueChange={setValue}
                maxGraphemes={MAX_GRAPHEMES}
                maxBytes={MAX_BYTES}
                placeholder={field.description || field.name}
                autoComplete="current-password"
                autoFocus={index === 0}
                disabled={busy}
              />
            ) : (
              <AxoTextField.Root disabled={busy}>
                <AxoTextField.Input
                  id={id}
                  name={field.id}
                  placeholder={field.description || field.name}
                  value={value}
                  onValueChange={setValue}
                  maxGraphemes={MAX_GRAPHEMES}
                  maxBytes={MAX_BYTES}
                  required={!field.optional}
                  autoFocus={index === 0}
                  spellCheck={false}
                />
              </AxoTextField.Root>
            )}
            {field.description && field.type !== 'password' && (
              <span className={tw('type-caption text-secondary')}>
                {field.description}
              </span>
            )}
          </div>
        );
      })}
      <div>
        <AxoButton.Root
          variant="strong-primary"
          size="md"
          disabled={missing}
          pending={busy}
          onClick={() => {
            if (!missing && !busy) {
              onSubmit(values);
            }
          }}
        >
          {i18n('icu:TrukiConnectedAccounts__Continue')}
        </AxoButton.Root>
      </div>
    </form>
  );
}

function errorText(
  i18n: LocalizerType,
  networkName: string,
  error: Readonly<{ code: string; message: string }>
): string {
  if (error.code === TRUKI_LOGIN_EXPIRED) {
    return i18n('icu:TrukiConnectedAccounts__LoginExpired');
  }
  if (error.code === TRUKI_LOGIN_UNSUPPORTED) {
    return i18n('icu:TrukiConnectedAccounts__UnsupportedStep', {
      network: networkName,
    });
  }
  return i18n('icu:TrukiConnectedAccounts__LoginFailed', {
    network: networkName,
  });
}

// One network's login, step by step: choose a flow, scan a QR code, type a
// phone number and read the pairing code, or log in in main's login window.
export const TrukiLoginFlow = memo(function TrukiLoginFlow({
  i18n,
  networkName,
  view,
  busy,
  onChooseFlow,
  onSubmitInput,
  onOpenCookieLogin,
  onCancel,
  onRetry,
}: TrukiLoginFlowProps): JSX.Element | null {
  let body: JSX.Element;
  switch (view.kind) {
    case 'waiting':
      body = (
        <div className={tw('flex items-center gap-3')}>
          <AxoLoadingIndicator.Root size="sm" />
          <Instructions
            text={
              view.instructions ||
              i18n('icu:TrukiConnectedAccounts__Waiting', {
                network: networkName,
              })
            }
          />
        </div>
      );
      break;
    case 'choose-flow':
      body = (
        <div className={tw('flex flex-col gap-2')}>
          <Instructions
            text={i18n('icu:TrukiConnectedAccounts__ChooseFlow', {
              network: networkName,
            })}
          />
          {view.flows.map(flow => (
            <div key={flow.id} className={tw('flex items-center gap-3')}>
              <AxoButton.Root
                variant="subtle-primary"
                size="md"
                disabled={busy}
                onClick={() => onChooseFlow(flow.id)}
              >
                {flow.name || flow.id}
              </AxoButton.Root>
              {flow.description && (
                <span className={tw('type-body-small text-secondary')}>
                  {flow.description}
                </span>
              )}
            </div>
          ))}
        </div>
      );
      break;
    case 'qr':
      body = (
        <div className={tw('flex flex-col items-start gap-3')}>
          <div className={tw('rounded-lg bg-[white] p-3')}>
            <QrCode
              alt={i18n('icu:TrukiConnectedAccounts__QrAlt', {
                network: networkName,
              })}
              className={tw('block size-56')}
              data={view.data}
            />
          </div>
          <Instructions
            text={
              view.instructions ||
              i18n('icu:TrukiConnectedAccounts__QrInstructions', {
                network: networkName,
              })
            }
          />
        </div>
      );
      break;
    case 'code':
      body = (
        <div className={tw('flex flex-col gap-3')}>
          <div
            data-testid="TrukiLoginCode"
            className={tw(
              'font-mono type-title-large tracking-[0.2em] text-primary',
              'select-all'
            )}
          >
            {view.code}
          </div>
          <Instructions
            text={
              view.instructions ||
              i18n('icu:TrukiConnectedAccounts__CodeInstructions', {
                network: networkName,
              })
            }
          />
        </div>
      );
      break;
    case 'input':
      body = (
        <InputForm
          // A new step starts with an empty form.
          key={view.stepId}
          i18n={i18n}
          fields={view.fields}
          instructions={view.instructions}
          busy={busy}
          onSubmit={onSubmitInput}
        />
      );
      break;
    case 'cookies':
      body = (
        <div className={tw('flex flex-col items-start gap-3')}>
          <Instructions
            text={i18n('icu:TrukiConnectedAccounts__CookiesInstructions', {
              network: networkName,
            })}
          />
          <AxoButton.Root
            variant="strong-primary"
            size="md"
            symbol="open"
            pending={busy}
            onClick={onOpenCookieLogin}
          >
            {i18n('icu:TrukiConnectedAccounts__OpenLoginWindow')}
          </AxoButton.Root>
        </div>
      );
      break;
    case 'error':
      body = (
        <div role="alert" className={tw('flex flex-col items-start gap-2')}>
          <Instructions text={errorText(i18n, networkName, view.error)} />
          {view.error.message && view.error.code !== TRUKI_LOGIN_EXPIRED && (
            <span className={tw('type-body-small text-secondary')}>
              {view.error.message}
            </span>
          )}
          <AxoButton.Root
            variant="strong-primary"
            size="md"
            pending={busy}
            onClick={onRetry}
          >
            {i18n('icu:TrukiConnectedAccounts__TryAgain')}
          </AxoButton.Root>
        </div>
      );
      break;
    case 'complete':
      return null;
    default:
      return null;
  }

  return (
    <div
      data-testid="TrukiLoginFlow"
      className={tw(
        'flex flex-col gap-4 rounded-lg border border-primary p-4',
        'bg-surface-secondary'
      )}
    >
      {body}
      <div>
        <AxoButton.Root variant="subtle-secondary" size="md" onClick={onCancel}>
          {i18n('icu:cancel')}
        </AxoButton.Root>
      </div>
    </div>
  );
});
