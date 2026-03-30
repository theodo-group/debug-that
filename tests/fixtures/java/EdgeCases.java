import java.util.*;
import java.util.stream.*;

public class EdgeCases {
    private String secret = "hidden";
    private int count = 99;
    public static final String CONST = "CONSTANT";

    public String getSecret() { return secret; }

    public void instanceMethod() {
        int local = 5;
        System.out.println("pause in instance"); // line 13 — instance method BP
    }

    public static void main(String[] args) {
        // Primitives
        int x = 42;
        double pi = 3.14;
        boolean flag = true;
        char ch = 'A';
        long big = 999999999999L;

        // Null
        String nullStr = null;

        // Array
        int[] nums = {1, 2, 3, 4, 5};
        String[] words = {"hello", "world"};

        // Nested objects
        Map<String, List<Integer>> nested = new HashMap<>();
        nested.put("key", List.of(10, 20, 30));

        // Lambdas / streams setup
        List<String> names = List.of("alice", "bob", "charlie");

        // Edge case: variable shadowing keyword-like names
        int value = 7;
        String thisIsNotThis = "tricky";

        // Object with private fields
        EdgeCases obj = new EdgeCases();

        System.out.println("pause here"); // line 45 — main BP
        obj.instanceMethod();
    }
}
