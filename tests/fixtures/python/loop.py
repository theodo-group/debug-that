import time


def compute(i):
    x = i * 2
    return x


def main():
    total = 0
    for i in range(100):
        total += compute(i)
        time.sleep(0.05)
    print(f"total={total}")


if __name__ == "__main__":
    main()
