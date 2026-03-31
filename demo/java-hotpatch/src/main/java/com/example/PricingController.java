package com.example;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import java.util.Map;

@RestController
public class PricingController {

    private static final double VAT_RATE = 0.20;

    @GetMapping("/price")
    public Map<String, Object> getPrice(
            @RequestParam(defaultValue = "49.99") double price,
            @RequestParam(defaultValue = "3") int qty,
            @RequestParam(defaultValue = "20") double discount) {

        double subtotal = price * qty;
        // BUG: VAT applied to discount instead of net amount
        double total = subtotal - discount + (discount * VAT_RATE);
        total = Math.round(total * 100.0) / 100.0;

        return Map.of(
            "subtotal", subtotal,
            "discount", discount,
            "vat_rate", VAT_RATE,
            "total", total
        );
    }
}
