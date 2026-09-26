package io.github.julienq1.realamadeus;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Base64;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.Reader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.Charset;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * JavaScript interface exposed as window.AmadeusAndroid (see web/src/native/bridge.ts).
 * Results are pushed back with window.__amadeus.dispatch(type, json).
 */
public class NativeBridge {
    private static final Charset UTF8 = Charset.forName("UTF-8");
    private static final int REQ_MIC = 1;
    private static final int REQ_NOTIFY = 2;
    private static final String CHANNEL_ID = "replies";

    private final MainActivity activity;
    private final WebView web;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Map<String, HttpURLConnection> requests = new ConcurrentHashMap<String, HttpURLConnection>();
    private final Map<String, Boolean> cancelled = new ConcurrentHashMap<String, Boolean>();

    private TextToSpeech tts;
    private volatile int ttsStatus = 0; // 0 pending, 1 ready, -1 failed
    private final List<Runnable> ttsQueue = new ArrayList<Runnable>();

    private SpeechRecognizer recognizer;
    private String pendingSttLang;

    NativeBridge(MainActivity activity, WebView web) {
        this.activity = activity;
        this.web = web;
        initTts();
    }

    void dispatch(String type, String payload) {
        final String js = "window.__amadeus&&window.__amadeus.dispatch(" + JSONObject.quote(type) + "," + JSONObject.quote(payload) + ")";
        web.post(new Runnable() {
            @Override
            public void run() {
                web.evaluateJavascript(js, null);
            }
        });
    }

    private void dispatch(String type, JSONObject payload) {
        dispatch(type, payload.toString());
    }

    private static JSONObject json(Object... kv) {
        JSONObject o = new JSONObject();
        try {
            for (int i = 0; i + 1 < kv.length; i += 2) o.put((String) kv[i], kv[i + 1]);
        } catch (JSONException ignored) {
        }
        return o;
    }

    private void onUi(Runnable r) {
        activity.runOnUiThread(r);
    }

    void shutdown() {
        for (HttpURLConnection c : requests.values()) c.disconnect();
        pool.shutdownNow();
        if (tts != null) tts.shutdown();
        if (recognizer != null) recognizer.destroy();
    }

    // ─── Info ───

    @JavascriptInterface
    public String info() {
        String version = "?";
        try {
            PackageInfo pi = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0);
            version = pi.versionName;
        } catch (PackageManager.NameNotFoundException ignored) {
        }
        return json("appVersion", version, "sdkInt", Build.VERSION.SDK_INT, "device", Build.MANUFACTURER + " " + Build.MODEL).toString();
    }

    // ─── HTTP (streamed, no CORS) ───

    @JavascriptInterface
    public void httpStart(final String id, final String method, final String url, final String headersJson, final String body) {
        pool.execute(new Runnable() {
            @Override
            public void run() {
                runRequest(id, method, url, headersJson, body);
            }
        });
    }

    @JavascriptInterface
    public void httpCancel(String id) {
        cancelled.put(id, Boolean.TRUE);
        HttpURLConnection c = requests.remove(id);
        if (c != null) c.disconnect();
    }

    private static boolean isTextType(String contentType) {
        if (contentType == null) return true;
        String t = contentType.toLowerCase(Locale.ROOT);
        return t.startsWith("text/") || t.contains("json") || t.contains("xml") || t.contains("javascript")
                || t.contains("x-www-form-urlencoded");
    }

    private void runRequest(String id, String method, String url, String headersJson, String body) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            requests.put(id, c);
            c.setRequestMethod(method);
            c.setConnectTimeout(30000);
            c.setReadTimeout(120000);
            c.setInstanceFollowRedirects(true);
            JSONObject headers = new JSONObject(headersJson == null || headersJson.isEmpty() ? "{}" : headersJson);
            Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                String lower = k.toLowerCase(Locale.ROOT);
                if (lower.equals("content-length") || lower.equals("host") || lower.equals("connection")) continue;
                c.setRequestProperty(k, headers.getString(k));
            }
            // Compressed event streams would be buffered by the decompressor.
            c.setRequestProperty("Accept-Encoding", "identity");
            if (body != null && !body.isEmpty()) {
                byte[] bytes = body.getBytes(UTF8);
                c.setDoOutput(true);
                c.setFixedLengthStreamingMode(bytes.length);
                OutputStream out = c.getOutputStream();
                out.write(bytes);
                out.close();
            }
            int status = c.getResponseCode();
            JSONObject respHeaders = new JSONObject();
            for (Map.Entry<String, List<String>> e : c.getHeaderFields().entrySet()) {
                if (e.getKey() != null && e.getValue() != null && !e.getValue().isEmpty()) {
                    respHeaders.put(e.getKey().toLowerCase(Locale.ROOT), e.getValue().get(0));
                }
            }
            dispatch("http", json("id", id, "event", "head", "status", status, "headers", respHeaders));
            InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
            if (in != null && isTextType(c.getContentType())) {
                Reader reader = new InputStreamReader(in, UTF8);
                char[] buf = new char[4096];
                int n;
                while ((n = reader.read(buf)) != -1) {
                    if (cancelled.containsKey(id)) break;
                    if (n > 0) dispatch("http", json("id", id, "event", "data", "chunk", new String(buf, 0, n)));
                }
                reader.close();
            } else if (in != null) {
                // Binary bodies (VOICEVOX audio) cross the bridge as base64.
                byte[] buf = new byte[48 * 1024];
                int n;
                while ((n = in.read(buf)) != -1) {
                    if (cancelled.containsKey(id)) break;
                    if (n > 0) dispatch("http", json("id", id, "event", "data", "b64", Base64.encodeToString(buf, 0, n, Base64.NO_WRAP)));
                }
                in.close();
            }
            if (!cancelled.containsKey(id)) dispatch("http", json("id", id, "event", "end"));
        } catch (IOException | JSONException | RuntimeException e) {
            if (!cancelled.containsKey(id)) {
                String msg = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
                if (e instanceof java.net.SocketTimeoutException) msg = "timeout: " + msg;
                dispatch("http", json("id", id, "event", "error", "message", msg));
            }
        } finally {
            requests.remove(id);
            cancelled.remove(id);
            if (c != null) c.disconnect();
        }
    }

    // ─── Text to speech ───

    private void initTts() {
        tts = new TextToSpeech(activity, new TextToSpeech.OnInitListener() {
            @Override
            public void onInit(int status) {
                ttsStatus = status == TextToSpeech.SUCCESS ? 1 : -1;
                if (ttsStatus == 1) {
                    tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                        @Override
                        public void onStart(String utteranceId) {
                            dispatch("tts", json("id", utteranceId, "event", "start"));
                        }

                        @Override
                        public void onDone(String utteranceId) {
                            dispatch("tts", json("id", utteranceId, "event", "done"));
                        }

                        @Override
                        @Deprecated
                        public void onError(String utteranceId) {
                            dispatch("tts", json("id", utteranceId, "event", "error"));
                        }

                        @Override
                        public void onStop(String utteranceId, boolean interrupted) {
                            dispatch("tts", json("id", utteranceId, "event", "stopped"));
                        }
                    });
                }
                synchronized (ttsQueue) {
                    for (Runnable r : ttsQueue) r.run();
                    ttsQueue.clear();
                }
            }
        });
    }

    @JavascriptInterface
    public boolean ttsAvailable() {
        return ttsStatus >= 0;
    }

    @JavascriptInterface
    public void ttsSpeak(final String id, final String text, final String lang, final float rate, final float pitch, final float volume) {
        Runnable speak = new Runnable() {
            @Override
            public void run() {
                if (ttsStatus != 1) {
                    dispatch("tts", json("id", id, "event", "error"));
                    return;
                }
                tts.setLanguage(Locale.forLanguageTag(lang));
                tts.setSpeechRate(rate);
                tts.setPitch(pitch);
                Bundle params = new Bundle();
                params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, Math.max(0f, Math.min(1f, volume)));
                tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, id);
            }
        };
        synchronized (ttsQueue) {
            if (ttsStatus == 0) {
                ttsQueue.add(speak);
                return;
            }
        }
        speak.run();
    }

    @JavascriptInterface
    public void ttsStop() {
        if (ttsStatus == 1) tts.stop();
    }

    // ─── Speech to text ───

    @JavascriptInterface
    public boolean sttAvailable() {
        return SpeechRecognizer.isRecognitionAvailable(activity);
    }

    @JavascriptInterface
    public void sttStart(final String lang) {
        onUi(new Runnable() {
            @Override
            public void run() {
                if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                    pendingSttLang = lang;
                    activity.requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                    return;
                }
                startRecognizer(lang);
            }
        });
    }

    @JavascriptInterface
    public void sttStop() {
        onUi(new Runnable() {
            @Override
            public void run() {
                if (recognizer != null) recognizer.stopListening();
            }
        });
    }

    private void startRecognizer(String lang) {
        if (!SpeechRecognizer.isRecognitionAvailable(activity)) {
            dispatch("stt", json("event", "error", "code", "unavailable"));
            dispatch("stt", json("event", "end"));
            return;
        }
        if (recognizer != null) recognizer.destroy();
        recognizer = SpeechRecognizer.createSpeechRecognizer(activity);
        recognizer.setRecognitionListener(new RecognitionListener() {
            private boolean finished;

            private void finish() {
                if (finished) return;
                finished = true;
                dispatch("stt", json("event", "end"));
            }

            @Override public void onReadyForSpeech(Bundle params) { dispatch("stt", json("event", "ready")); }
            @Override public void onBeginningOfSpeech() { }
            @Override public void onRmsChanged(float rmsdB) { }
            @Override public void onBufferReceived(byte[] buffer) { }
            @Override public void onEndOfSpeech() { }
            @Override public void onEvent(int eventType, Bundle params) { }

            @Override
            public void onError(int error) {
                String code;
                switch (error) {
                    case SpeechRecognizer.ERROR_NO_MATCH: code = "no-match"; break;
                    case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: code = "no-speech"; break;
                    case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: code = "permission"; break;
                    case SpeechRecognizer.ERROR_NETWORK:
                    case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: code = "network"; break;
                    default: code = "error-" + error;
                }
                dispatch("stt", json("event", "error", "code", code));
                finish();
            }

            @Override
            public void onPartialResults(Bundle partial) {
                List<String> r = partial.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                if (r != null && !r.isEmpty()) dispatch("stt", json("event", "partial", "text", r.get(0)));
            }

            @Override
            public void onResults(Bundle results) {
                List<String> r = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                if (r != null && !r.isEmpty()) dispatch("stt", json("event", "result", "text", r.get(0)));
                finish();
            }
        });
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        recognizer.startListening(intent);
    }

    void onPermissionResult(int requestCode, boolean granted) {
        if (requestCode == REQ_MIC) {
            if (granted && pendingSttLang != null) {
                startRecognizer(pendingSttLang);
            } else {
                dispatch("stt", json("event", "error", "code", "permission"));
                dispatch("stt", json("event", "end"));
            }
            pendingSttLang = null;
        }
        dispatch("permission", json("request", requestCode, "granted", granted));
    }

    // ─── Notifications ───

    @JavascriptInterface
    public void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33
                && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            onUi(new Runnable() {
                @Override
                public void run() {
                    activity.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
                }
            });
        }
    }

    @JavascriptInterface
    public void notify(String title, String text) {
        if (activity.inForeground) return;
        if (Build.VERSION.SDK_INT >= 33
                && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        NotificationManager nm = (NotificationManager) activity.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL_ID,
                    activity.getString(R.string.channel_replies), NotificationManager.IMPORTANCE_DEFAULT));
        }
        Intent open = new Intent(activity, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(activity, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(activity, CHANNEL_ID) : legacyBuilder();
        b.setSmallIcon(R.drawable.ic_stat_amadeus)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(pi)
                .setAutoCancel(true);
        nm.notify(1, b.build());
    }

    @SuppressWarnings("deprecation")
    private Notification.Builder legacyBuilder() {
        return new Notification.Builder(activity);
    }

    // ─── Window & misc ───

    @JavascriptInterface
    public void setImmersive(final boolean enabled) {
        onUi(new Runnable() {
            @Override
            public void run() {
                activity.setImmersiveMode(enabled);
            }
        });
    }

    @JavascriptInterface
    public void setKeepScreenOn(final boolean enabled) {
        onUi(new Runnable() {
            @Override
            public void run() {
                if (enabled) activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
        });
    }

    @JavascriptInterface
    @SuppressWarnings("deprecation")
    public void vibrate(int ms) {
        Vibrator v = (Vibrator) activity.getSystemService(Context.VIBRATOR_SERVICE);
        if (v == null || !v.hasVibrator()) return;
        if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createOneShot(Math.max(1, ms), VibrationEffect.DEFAULT_AMPLITUDE));
        else v.vibrate(ms);
    }

    @JavascriptInterface
    public void openUrl(final String url) {
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) return;
        onUi(new Runnable() {
            @Override
            public void run() {
                activity.openExternal(url);
            }
        });
    }

    @JavascriptInterface
    public void moveToBack() {
        onUi(new Runnable() {
            @Override
            public void run() {
                activity.moveTaskToBack(true);
            }
        });
    }

    @JavascriptInterface
    public void exitApp() {
        onUi(new Runnable() {
            @Override
            public void run() {
                activity.finishAndRemoveTask();
            }
        });
    }

}
