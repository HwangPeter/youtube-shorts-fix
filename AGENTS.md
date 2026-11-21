# Agent rules

- Testing before merge: run only the tests for the new feature or the behaviour a change affects, not the full real-browser suite. Unit tests for the touched code (`node --test test/<file>.test.mjs`) plus the matching section of a real-browser test (for example `npm run test:refresh:button`) are enough. Run the full real-browser tests (`npm run test:refresh`, `npm run test:repro`, `npm run test:proof`) only when a change affects their behaviour as a whole or someone asks for them.
