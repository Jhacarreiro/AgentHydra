"""One owned, file-free HTTP phase. Private input arrives only after containment."""

import argparse
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--owned-phase-job', required=True)
    args = parser.parse_args()
    from .request_ownership import json_frame, read_phase_request

    value = read_phase_request(args.owned_phase_job)
    # No HTTP object, state store or account operation exists before this handshake.
    from .request_phases import preflight, readback

    operation = {'preflight': preflight, 'readback': readback}.get(value.get('phase'))
    if operation is None or not isinstance(value.get('arguments'), dict):
        raise ValueError('Invalid HTTP phase')
    result = operation(**value['arguments'])
    sys.stdout.buffer.write(json_frame(result))
    sys.stdout.buffer.flush()


if __name__ == '__main__':
    main()
