// Runs every native assertion and repetition for the repo topology, with its own fixture.
import { nativeContract } from '../tests/provider-contract-native.test';
nativeContract(['repo']);
