// Must come first: the chip protocol needs a secure random source, and on
// React Native `globalThis.crypto` does not exist until this polyfill runs.
import 'react-native-get-random-values';

import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { readPassport } from '@kyc/mrtd';
import { parseSessionLink, submitChipRead, type ChipVerdict, type Session } from './src/api';
import { explain, isAvailable, withChip } from './src/nfc';

/**
 * Reading the chip in a passport, on a phone.
 *
 * This app exists for one reason the website cannot cover: a browser cannot
 * talk to a chip. Everything else in the verification — details, photographs,
 * the outcome — is already handled on the web, and duplicating it here would
 * be two things to keep in step. So the applicant arrives from a link, reads
 * their chip, and goes back.
 *
 * The three fields it asks for are not registration. They are the key: a chip
 * will not answer until the reader proves it is holding the document, and it
 * does that by deriving keys from what is printed on the photo page. This is
 * why a passport cannot be read through a coat pocket, and why the app has to
 * ask.
 */

type Stage =
  | { name: 'waiting' }
  | { name: 'details' }
  | { name: 'reading'; message: string }
  | { name: 'done'; verdict: ChipVerdict }
  | { name: 'failed'; message: string };

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [stage, setStage] = useState<Stage>({ name: 'waiting' });
  const [nfc, setNfc] = useState<boolean | null>(null);

  const [documentNumber, setDocumentNumber] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [dateOfExpiry, setDateOfExpiry] = useState('');

  useEffect(() => {
    void isAvailable().then(setNfc);

    const open = (url: string | null) => {
      if (!url) return;
      const parsed = parseSessionLink(url);
      if (parsed) {
        setSession(parsed);
        setStage({ name: 'details' });
      }
    };
    void Linking.getInitialURL().then(open);
    const listener = Linking.addEventListener('url', (event) => open(event.url));
    return () => listener.remove();
  }, []);

  async function read() {
    if (!session) return;
    const mrz = {
      documentNumber: documentNumber.trim().toUpperCase(),
      dateOfBirth: dateOfBirth.trim(),
      dateOfExpiry: dateOfExpiry.trim(),
    };

    try {
      const verdict = await withChip(
        (message) => setStage({ name: 'reading', message }),
        async (transport) => {
          const read = await readPassport(transport, mrz);
          setStage({ name: 'reading', message: 'Checking with the issuing country' });
          return submitChipRead(session, read, mrz);
        },
      );
      setStage({ name: 'done', verdict });
    } catch (error) {
      setStage({ name: 'failed', message: explain(error) });
    }
  }

  const ready =
    /^[A-Z0-9<]{5,9}$/.test(documentNumber.trim().toUpperCase()) &&
    /^\d{6}$/.test(dateOfBirth.trim()) &&
    /^\d{6}$/.test(dateOfExpiry.trim());

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Identity check</Text>

        {nfc === false ? (
          <Text style={styles.note}>
            This phone cannot read passport chips. Continue on the website — a reviewer will check
            the photo page instead.
          </Text>
        ) : null}

        {stage.name === 'waiting' ? (
          <Text style={styles.note}>
            Open the link the business sent you to begin. This app only reads the chip; the rest of
            your verification happens in your browser.
          </Text>
        ) : null}

        {stage.name === 'details' ? (
          <View>
            <Text style={styles.lead}>
              Copy these three from the bottom of your passport&apos;s photo page. They are what
              unlocks the chip — without them it stays shut, which is what stops it being read from
              a pocket.
            </Text>

            <Field
              label="Passport number"
              value={documentNumber}
              onChange={setDocumentNumber}
              placeholder="L898902C"
              autoCapitalize="characters"
            />
            <Field
              label="Date of birth"
              value={dateOfBirth}
              onChange={setDateOfBirth}
              placeholder="YYMMDD, e.g. 690806"
              keyboardType="number-pad"
            />
            <Field
              label="Expiry date"
              value={dateOfExpiry}
              onChange={setDateOfExpiry}
              placeholder="YYMMDD, e.g. 940623"
              keyboardType="number-pad"
            />

            <Pressable
              style={[styles.button, !ready && styles.buttonOff]}
              disabled={!ready}
              onPress={() => void read()}
            >
              <Text style={styles.buttonText}>Scan the chip</Text>
            </Pressable>
          </View>
        ) : null}

        {stage.name === 'reading' ? (
          <View style={styles.centre}>
            <ActivityIndicator size="large" />
            <Text style={styles.lead}>{stage.message}</Text>
            <Text style={styles.note}>
              The chip is powered by the phone, so it stops the moment they part. Hold it still.
            </Text>
          </View>
        ) : null}

        {stage.name === 'done' ? <Verdict verdict={stage.verdict} /> : null}

        {stage.name === 'failed' ? (
          <View>
            <Text style={styles.bad}>{stage.message}</Text>
            <Pressable style={styles.button} onPress={() => setStage({ name: 'details' })}>
              <Text style={styles.buttonText}>Try again</Text>
            </Pressable>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Verdict({ verdict }: { verdict: ChipVerdict }) {
  return (
    <View>
      <Text style={verdict.passiveAuthPassed ? styles.good : styles.bad}>
        {verdict.passiveAuthPassed
          ? 'Verified against the issuing country'
          : 'This chip did not verify'}
      </Text>
      <Text style={styles.lead}>
        {verdict.passiveAuthPassed
          ? 'The country that issued your passport signed its contents, and that signature checks out. You can close this and return to your browser.'
          : 'The signature on this chip could not be confirmed. A reviewer will look at your document by hand.'}
      </Text>

      {/* Stated plainly rather than buried. Passive authentication proves the
          data was written by the issuer; it cannot prove the chip is not a
          copy of a genuine one, and a screen that implied otherwise would be
          overclaiming on the strength of a green tick. */}
      <Text style={styles.note}>
        This confirms the data came from the issuing country and has not been altered. Checking
        that the chip itself is not a copy is a separate step.
      </Text>

      {verdict.findings
        .filter((f) => f.severity !== 'INFO')
        .map((f) => (
          <Text key={f.code} style={styles.note}>
            • {f.message}
          </Text>
        ))}
    </View>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  autoCapitalize,
  keyboardType,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  autoCapitalize?: 'none' | 'characters';
  keyboardType?: 'default' | 'number-pad';
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        autoCapitalize={autoCapitalize ?? 'none'}
        autoCorrect={false}
        keyboardType={keyboardType ?? 'default'}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f7f8fa' },
  content: { padding: 24, gap: 16 },
  title: { fontSize: 26, fontWeight: '600', color: '#16191d' },
  lead: { fontSize: 15, lineHeight: 22, color: '#16191d', marginBottom: 12 },
  note: { fontSize: 13, lineHeight: 19, color: '#5c6672', marginTop: 8 },
  good: { fontSize: 18, fontWeight: '600', color: '#1f7a4d', marginBottom: 8 },
  bad: { fontSize: 16, fontWeight: '600', color: '#b3261e', marginBottom: 12 },
  centre: { alignItems: 'center', gap: 12, paddingVertical: 40 },
  field: { marginBottom: 14 },
  label: { fontSize: 13, color: '#5c6672', marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: '#dfe3e9',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    backgroundColor: '#ffffff',
  },
  button: {
    backgroundColor: '#2f5fd0',
    borderRadius: 8,
    padding: 15,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonOff: { backgroundColor: '#a9b6cf' },
  buttonText: { color: '#ffffff', fontSize: 16, fontWeight: '600' },
});
