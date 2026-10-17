import { isAcceptedLineJumpInput, parseLineJumpTarget } from '../webview/src/helpers/lineJump';

const acceptedInputs = ['', '1', '10', '9999'];
for (const value of acceptedInputs) {
  if (!isAcceptedLineJumpInput(value)) {
    throw new Error(`Expected line input to be accepted: ${JSON.stringify(value)}`);
  }
}

const rejectedInputs = ['0', '01', '-1', '1.5', '1a', ' 1'];
for (const value of rejectedInputs) {
  if (isAcceptedLineJumpInput(value)) {
    throw new Error(`Expected line input to be rejected: ${JSON.stringify(value)}`);
  }
}

if (parseLineJumpTarget('1', 20) !== 1 || parseLineJumpTarget('20', 20) !== 20) {
  throw new Error('Valid line target was rejected');
}
for (const value of ['21', '9999', '9007199254740993', '9'.repeat(400)]) {
  if (parseLineJumpTarget(value, 20) !== 20) {
    throw new Error(`Expected an oversized line target to jump to the final line: ${value}`);
  }
}
if (parseLineJumpTarget('2', 1) !== 1) {
  throw new Error('An oversized target in a single-line document did not jump to line 1');
}
if (parseLineJumpTarget('0', 20) !== null || parseLineJumpTarget('21', 0) !== null) {
  throw new Error('Invalid line target or unavailable document was accepted');
}

console.log('line jump checks passed');
