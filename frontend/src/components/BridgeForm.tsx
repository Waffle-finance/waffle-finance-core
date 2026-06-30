import type React from 'react';
import BridgeFormContainer, {
  getUnsupportedRouteReason,
  type BridgeFormProps,
} from '../features/bridge/BridgeFormContainer';

/**
 * Thin public component boundary for the bridge form.
 *
 * The implementation lives in features/bridge so this shared components folder
 * remains guarded by targeted maintainability lint rules. Keep this file small:
 * bridge business logic should be added to feature hooks/helpers instead of
 * expanding this wrapper.
 */
export default function BridgeForm(props: BridgeFormProps): React.JSX.Element {
  return <BridgeFormContainer {...props} />;
}

export { getUnsupportedRouteReason };
