// The event this drop is for — the same artwork and copy for every event the demo creates.
//
// Static on purpose. Nothing about the festival lives in the module: `event.name` is an
// operator's label ("round-2-turn"), not a product, and adding an image URL and three
// paragraphs of marketing copy to a table that five reducers read on every draw would be
// paying schema cost for something that never varies. If a second festival ever needs a second
// hero, that is the moment to make it data — not before.
//
// The copy is transcribed from the Lollapalooza India 2027 listing as prose, NOT injected as
// HTML: `dangerouslySetInnerHTML` on vendor markup is how a page ends up rendering someone
// else's `<script>`, and the source had nothing in it but paragraphs anyway.

import { useState } from "react";

/** Lives in `public/`, so it is copied verbatim and referenced by a stable absolute path —
 *  no hashed import, and the same URL in dev and in the Vercel build. */
const POSTER = "/lollapalooza-india-2027.avif";

export function EventHero() {
  // Collapsed by default. On a phone the whole point of this page is the Join button, and
  // three paragraphs of festival copy above the fold pushes it off the screen.
  const [open, setOpen] = useState(false);

  return (
    <div className="card hero">
      <img
        className="hero-img" src={POSTER} width={1200} height={630}
        alt="Lollapalooza India 2027 — January 23 and 24, 2027"
      />
      <h2 style={{ marginTop: ".9rem" }}>Lollapalooza India 2027</h2>
      <p className="hero-dates">January 23–24, 2027 · four stages</p>
      <p style={{ marginTop: 0 }}>
        We're hitting FIVE, a milestone where legacy meets its loudest chapter. Lollapalooza
        India returns on January 23–24, 2027, bigger than ever, with an array of global and
        homegrown artists taking over four iconic stages in a celebration of music at its most
        powerful.
      </p>

      {open && (
        <>
          <p>
            What began as a global movement over three decades ago in Chicago now stands as a
            defining cultural landmark in India, bringing together generations of fans,
            boundary-pushing sounds, and unforgettable live moments. From pop and rock to indie,
            hip-hop, and beyond, Lolla India continues to set the stage for what music can feel
            like at scale.
          </p>
          <p style={{ marginBottom: 0 }}>
            This is more than a festival. It's five years of sound, culture, and community —
            coming together in its most expansive form yet.
          </p>
        </>
      )}

      <button className="secondary help" onClick={() => setOpen((v) => !v)}>
        {open ? "Show less" : "Read more"}
      </button>
    </div>
  );
}
