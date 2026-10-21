
def classify_email(email):
    text = email.lower()

    if "disagree" in text:
        return "Disagreed"

    elif "agree" in text:
        return "Agreed"

    else:
        return "Review"


email = "We agree with your proposal"

result = classify_email(email)

print(result)


from openai import OpenAI
client = OpenAI()
