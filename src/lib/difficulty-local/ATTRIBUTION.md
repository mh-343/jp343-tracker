# Attribution / third-party data

The local difficulty estimator ships one third-party dataset, bundled as
`data/jlpt-index.json` (compiled from the JLPT vocabulary lists):

- **JLPT vocabulary lists**: [jamsinclair/open-anki-jlpt-decks](https://github.com/jamsinclair/open-anki-jlpt-decks)
  (MIT), based on the JLPT resources of [Jonathan Waller / tanos.co.uk](http://www.tanos.co.uk/jlpt/)
  (Creative Commons BY, "credit my site"). Official JLPT lists no longer exist
  since 2010; all level assignments are community estimates.

No frequency list is shipped. Tokenization uses the browser-native
`Intl.Segmenter` plus the deinflection rules in this folder; there is no
dictionary and no MeCab/UniDic.
