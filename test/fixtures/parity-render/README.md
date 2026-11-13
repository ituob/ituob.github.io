These focused source fixtures preserve the actual source text, not a generated
HTML expectation. Issue metadata, own-annex records, and the three AsciiDoc
communications are copied from service-publications-docs `881e84d8` (`ob-issues`).
List metadata is from the existing parity reference's itu-ob-data `e17484be`.

The test supplies a minimal layout to isolate public issue/component rendering
from Vue site chrome. It adds a running-annex message to explicitly incomplete
issue 669 to prove that the source disclaimer survives partial content. The T.35
row uses Germany's source fields from `datasets/1001-T.35B/data.yaml`; its printed
question comes from the existing Jekyll reference's T35_NA message page.
