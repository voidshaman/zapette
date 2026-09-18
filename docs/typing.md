# Typing on the TV

How text reaches the TV, and what the TV's own keyboard does to it on the way.
Everything here was measured by reading the TV's field back after injecting.

## TV keyboards

`adb shell input text` turns each character into a **US key position**, and the TV renders that
position through its own keyboard. Measured on this TCL, whose keyboard is French AZERTY, by reading
the field back after every injection:

    injected a q z w m ; ,      TV showed q a w z , m ;
    injected @ ) _ - 1          TV showed 2 0 degrees ) &

The same keyboard also loses characters. Injected `hello` arrived as `hell`, `llll` as `lll`,
`helloworld` as `hellzorld`: repeated key events are treated as multi-press and the repeat is eaten.
No translation can recover a key the TV never took.

Selecting the stock keyboard instead fixes both at once. With it, every injection arrived exactly as
sent, including the letters AZERTY moves and words with doubled letters. A switch costs 0.15 seconds
and applies immediately, so the app borrows that keyboard for as long as text is going out: it switches
when the sender needs it and hands the TV its own keyboard back six seconds after the last send. The TV
is left as it was found unless i is pressed, which pins the borrowed keyboard in place; i again goes
back to borrowing it only when sending.

The layout is read from the TV on connect and whenever the keyboard changes, so while the TV is on its
own keyboard the letters that remap are translated on the way out and a TV that cannot be switched
still types mostly right. k cycles that translation between automatic, on and off. Characters behind
AltGr on AZERTY, `@` and `#` among them, cannot be produced by `input text` at all, since it can
express base and shift only: the app names them instead of pretending they were sent.

## Mirror mode

The field is read with a uiautomator dump, about 2.5 seconds, twice a moment apart: Leanback's search
field animates its text in, and a read taken straight after typing catches only a prefix of it
(`hello` came back as `hell`). An empty Android field reports its own hint through accessibility, so a
bare search box reads as `Rechercher`; hint text counts as empty, and a hint the app has not seen
before is learned the first time it empties the field itself.

Where the caret sits is the one thing a dump does not report, and guessing it wrong puts an edit in the
wrong place: clearing an 8-character field left its last character behind and the next insert landed in
front of it. So an edit never assumes the caret. It parks the caret at the end first, then walks back,
deletes and inserts as much as is needed and no more: appending a word is one insert, clearing a field
is one delete run, and a change in the middle is a walk back, a delete run and one insert. Any edit
that removed text is followed by another read, so a model that drifted is corrected rather than
trusted.

