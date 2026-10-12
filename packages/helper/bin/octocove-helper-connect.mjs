#!/usr/bin/env node
import { runConnector } from '../src/connect.mjs';

// ext:: passes the git service name as the first argument; GIT_PROTOCOL arrives via env.
runConnector({
  service: process.argv[2],
  socketPath: process.env.OCTOCOVE_HELPER_SOCK,
  gitProtocol: process.env.GIT_PROTOCOL ?? '',
  stdin: process.stdin,
  stdout: process.stdout,
  onExit: code => process.exit(code),
});
