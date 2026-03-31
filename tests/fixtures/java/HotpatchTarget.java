public class HotpatchTarget {
    public static String getMessage() {
        return "original";
    }

    public static int compute(int a, int b) {
        return a + b;
    }

    public static void main(String[] args) {
        // Pause here, then hotpatch before continuing
        System.out.println("message=" + getMessage());
        System.out.println("compute=" + compute(3, 4));
    }
}
