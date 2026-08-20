# Identity Check — the chip reader

A browser cannot talk to a passport chip. That is the only reason this app
exists: everything else in a verification — details, photographs, the outcome —
already happens on the web, and duplicating it here would be two things to keep
in step. An applicant arrives from a link, reads their chip, and goes back.

## What it does

Derives the chip's access keys from the three fields printed on the photo page,
opens a session, reads the machine-readable zone and the portrait along with the
security object the issuing country signed, and hands all of it to the server.

It reaches no verdict of its own. Passive authentication happens on a server the
applicant does not control, against a trust store they cannot edit — a phone
that judged its own passport would be one an attacker could reimplement.

## What is proven and what is not

The protocol is verified without a device. `packages/mrtd` checks key
derivation and the mutual authentication exchange against ICAO's published
worked example, byte for byte, and runs the full read against a chip simulated
in memory that implements the other half of the standard. The cipher is checked
against OpenSSL across thousands of random inputs.

What is **not** proven is `src/nfc.ts` — roughly forty lines that hand bytes to
the radio. That needs a physical phone and a real passport. A fault there shows
up as "no answer", not as a wrong verification, because everything it feeds is
tested.

## Running it

Expo Go will not work: NFC needs native modules, so this needs a development
build.

```bash
npm install
npm run -w @kyc/mrtd build     # the app resolves the built package, not the source
npm run -w @kyc/mobile prebuild
npm run -w @kyc/mobile android # or ios
```

### Before it can run on a phone

- **Android** — a device with NFC. Nothing else; development needs no account.
- **iOS** — a paid Apple Developer account. Reading a passport requires the
  `com.apple.developer.nfc.readersession.formats` entitlement, and Apple issues
  that only against a paid membership. There is no way around it, and it is
  worth knowing before planning an iOS release.
- **A real passport.** A simulated chip proves the protocol; only a genuine one
  proves the radio.

## Deep link

```
kyc://chip?token=<sdk token>&applicant=<id>&api=https://<api host>
```

The token is a bearer credential, so the link is refused over plain `http`
outside localhost.
