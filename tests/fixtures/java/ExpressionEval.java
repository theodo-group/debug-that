import java.util.List;
import java.util.ArrayList;

public class ExpressionEval {
    private String name;
    private int value;

    public ExpressionEval(String name, int value) {
        this.name = name;
        this.value = value;
    }

    public String getName() { return name; }
    public int getValue() { return value; }
    public String greet(String prefix) { return prefix + " " + name; }

    public static void main(String[] args) {
        int a = 10;
        int b = 20;
        String greeting = "hello";
        ExpressionEval obj = new ExpressionEval("world", 42);
        List<String> items = new ArrayList<>();
        items.add("alpha");
        items.add("beta");
        items.add("gamma");
        System.out.println("pause here"); // line 26 — breakpoint target
    }
}
