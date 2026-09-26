import com.android.apksig.ApkSigner;
import com.android.apksig.ApkVerifier;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;
import java.util.Collections;

/**
 * Signs an APK with the v2 scheme (all supported devices run Android 7.0+, which verifies v2;
 * the v1 JAR signer of apksig 2.3.0 no longer runs on current JDKs) and verifies the result.
 */
public class ApkSign {
    public static void main(String[] args) throws Exception {
        if (args.length != 6) {
            System.err.println("usage: ApkSign <in.apk> <out.apk> <keystore.p12> <password> <alias> <minSdk>");
            System.exit(2);
        }
        KeyStore ks = KeyStore.getInstance("PKCS12");
        InputStream in = new FileInputStream(args[2]);
        try {
            ks.load(in, args[3].toCharArray());
        } finally {
            in.close();
        }
        PrivateKey key = (PrivateKey) ks.getKey(args[4], args[3].toCharArray());
        X509Certificate cert = (X509Certificate) ks.getCertificate(args[4]);
        ApkSigner.SignerConfig signer =
                new ApkSigner.SignerConfig.Builder("AMADEUS", key, Collections.singletonList(cert)).build();
        new ApkSigner.Builder(Collections.singletonList(signer))
                .setInputApk(new File(args[0]))
                .setOutputApk(new File(args[1]))
                .setMinSdkVersion(Integer.parseInt(args[5]))
                .setV1SigningEnabled(false)
                .setV2SigningEnabled(true)
                .setCreatedBy("Real Amadeus Mobile build")
                .build()
                .sign();

        ApkVerifier.Result result = new ApkVerifier.Builder(new File(args[1])).build().verify();
        System.out.println("signature verified=" + result.isVerified() + " v2=" + result.isVerifiedUsingV2Scheme());
        if (!result.isVerified()) {
            for (Object e : result.getErrors()) System.err.println("error: " + e);
            System.exit(1);
        }
    }
}
