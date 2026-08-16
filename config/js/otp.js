document.getElementById("otpForm").addEventListener("submit", async function (event) {
    event.preventDefault();
    const otp = document.getElementById("otpCode").value;
    const email = document.getElementById("emailVerify").value;

    const response = await fetch("/verify-otp", {
        method: "POST",
        body: JSON.stringify({ email, otp }),
        headers: { "Content-Type": "application/json" }
    });

    const data = await response.json();
    const flashMessage = document.getElementById("otpFlashMessage");

    flashMessage.style.display = "block";
    flashMessage.textContent = data.message;
    flashMessage.className = data.success ? "alert alert-success" : "alert alert-danger";

    if (data.success) {
        setTimeout(() => {
            var otpModal = bootstrap.Modal.getInstance(document.getElementById('otpModal'));
            otpModal.hide();
            var registerModal = new bootstrap.Modal(document.getElementById('registerModal'));
            registerModal.show();

            document.getElementById("email").value = email;
            document.getElementById("email").readOnly = true;
        }, 1000);
    }
});
